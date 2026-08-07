"use client";

import { useState } from "react";
import { extractPhotoMetadataSafe } from "@/lib/exif";
import { fetchHistoricalWeather, type WeatherResult } from "@/lib/weather";

type WeatherStatus = "idle" | "loading" | "done" | "no-date" | "no-gps" | "error";

type Photo = {
  id: string;
  file: File;
  previewUrl: string;
  status: "loading" | "done";
  hasDate: boolean;
  hasGps: boolean;
  dateTimeOriginal: Date | null;
  latitude: number | null;
  longitude: number | null;
  previewError: boolean;
  /** EXIF 파싱 자체가 실패했을 때의 메시지 (EXIF가 그냥 없는 것과는 다름) */
  metaError: string | null;
  weatherStatus: WeatherStatus;
  weather: WeatherResult | null;
  /** 날씨를 못 가져온 이유를 사람이 읽을 수 있는 문장으로 */
  weatherMessage: string | null;
};

function formatDate(date: Date | null): string {
  if (!date) return "메타데이터 없음";
  return date
    .toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
    .replace(/\. /g, ".");
}

function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

function formatGps(lat: number | null, lng: number | null): string {
  if (lat === null || lng === null) return "메타데이터 없음";
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function timestamp(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

export default function Home() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [lastSelectionCount, setLastSelectionCount] = useState(0);

  function addLog(message: string) {
    setDebugLog((prev) => [...prev.slice(-49), `${timestamp()}  ${message}`]);
  }

  // 날씨 조회는 메타데이터 처리와 별도의 단계다.
  // GPS/날짜가 없으면 API를 호출하지 않고 바로 이유를 표시하고,
  // API 호출이 실패해도 사진 자체(미리보기·메타데이터)는 그대로 남는다.
  async function fetchWeatherForPhoto(
    photoId: string,
    fileName: string,
    hasDate: boolean,
    hasGps: boolean,
    date: Date | null,
    lat: number | null,
    lon: number | null
  ) {
    if (!hasDate) {
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photoId
            ? {
                ...p,
                weatherStatus: "no-date",
                weatherMessage: "촬영 날짜가 없어 날씨를 불러올 수 없음",
              }
            : p
        )
      );
      return;
    }
    if (!hasGps) {
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photoId
            ? {
                ...p,
                weatherStatus: "no-gps",
                weatherMessage: "위치 정보가 없어 날씨를 불러올 수 없음",
              }
            : p
        )
      );
      return;
    }

    setPhotos((prev) =>
      prev.map((p) =>
        p.id === photoId ? { ...p, weatherStatus: "loading" } : p
      )
    );
    addLog(`[${fileName}] 날씨 조회 시작 (${lat}, ${lon})`);

    try {
      const weather = await fetchHistoricalWeather(lat as number, lon as number, date as Date);
      addLog(`[${fileName}] 날씨 조회 성공 (${weather.weatherLabel})`);
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photoId
            ? { ...p, weatherStatus: "done", weather, weatherMessage: null }
            : p
        )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addLog(`[${fileName}] 날씨 조회 실패: ${message}`);
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photoId
            ? { ...p, weatherStatus: "error", weatherMessage: "날씨 조회 실패" }
            : p
        )
      );
    }
  }

  // 파일 하나에 대한 처리는 완전히 독립적으로 실행된다.
  // 여기서 어떤 예외가 나더라도(이미 extractPhotoMetadataSafe 내부에서 잡지만,
  // 방어적으로 한 번 더 감싼다) 다른 파일 처리에는 영향을 주지 않는다.
  async function processOnePhoto(photo: Photo) {
    addLog(`[${photo.file.name}] 메타데이터 추출 시작`);
    try {
      const meta = await extractPhotoMetadataSafe(photo.file);

      if (meta.error) {
        addLog(`[${photo.file.name}] 추출 실패: ${meta.error}`);
      } else {
        addLog(
          `[${photo.file.name}] 추출 성공 (날짜:${meta.hasDate ? "O" : "X"} GPS:${
            meta.hasGps ? "O" : "X"
          })`
        );
      }

      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photo.id
            ? {
                ...p,
                status: "done",
                hasDate: meta.hasDate,
                hasGps: meta.hasGps,
                dateTimeOriginal: meta.dateTimeOriginal,
                latitude: meta.latitude,
                longitude: meta.longitude,
                metaError: meta.error,
              }
            : p
        )
      );

      // 메타데이터 실패 여부와 무관하게, 날씨 조회는 별도로 시도한다.
      // (한 사진의 날씨 실패가 다른 사진에 영향을 주지 않도록 여기서 await만 하고
      //  예외는 fetchWeatherForPhoto 내부에서 전부 처리된다.)
      await fetchWeatherForPhoto(
        photo.id,
        photo.file.name,
        meta.hasDate,
        meta.hasGps,
        meta.dateTimeOriginal,
        meta.latitude,
        meta.longitude
      );
    } catch (err) {
      // extractPhotoMetadataSafe는 이론상 절대 throw하지 않지만,
      // 예상치 못한 런타임 오류(iOS 특이 케이스 등)에 대한 마지막 안전망.
      const message = err instanceof Error ? err.message : String(err);
      addLog(`[${photo.file.name}] 예상치 못한 예외: ${message}`);
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === photo.id ? { ...p, status: "done", metaError: message } : p
        )
      );
    }
  }

  async function handleFiles(fileList: FileList | null) {
    addLog(`onChange 이벤트 발생 (files=${fileList ? fileList.length : "null"})`);

    if (!fileList || fileList.length === 0) {
      addLog("선택된 파일이 없음 (fileList가 비어 있음)");
      return;
    }

    const files = Array.from(fileList);
    setLastSelectionCount(files.length);

    // 미리보기는 메타데이터 파싱과 완전히 분리해서 즉시 만든다.
    // objectURL 생성 자체가 실패해도 리스트에는 반드시 항목이 뜬다.
    const initial: Photo[] = files.map((file) => {
      let previewUrl = "";
      let previewCreateFailed = false;
      try {
        previewUrl = URL.createObjectURL(file);
      } catch (err) {
        previewCreateFailed = true;
        addLog(
          `[${file.name}] 미리보기 URL 생성 실패: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      return {
        id: `${file.name}-${file.lastModified}-${file.size}-${Math.random()
          .toString(36)
          .slice(2)}`,
        file,
        previewUrl,
        status: "loading",
        hasDate: false,
        hasGps: false,
        dateTimeOriginal: null,
        latitude: null,
        longitude: null,
        previewError: previewCreateFailed,
        metaError: null,
        weatherStatus: "idle",
        weather: null,
        weatherMessage: null,
      };
    });

    addLog(`미리보기 ${initial.length}장 렌더링`);
    setPhotos((prev) => [...initial, ...prev]);

    // 파일별로 독립적인 프로미스를 "동시에" 시작한다 (순차 await 아님).
    // 하나가 멈추거나 실패해도 나머지는 그대로 진행된다.
    const results = await Promise.allSettled(initial.map(processOnePhoto));
    const rejected = results.filter((r) => r.status === "rejected").length;
    addLog(
      `배치 처리 종료: 총 ${results.length}장 중 ${rejected}장에서 미처리 예외 발생`
    );
  }

  const total = photos.length;
  const doneCount = photos.filter((p) => p.status === "done").length;
  const successCount = photos.filter(
    (p) => p.status === "done" && !p.metaError
  ).length;
  const failCount = photos.filter((p) => p.status === "done" && p.metaError).length;
  const processingNames = photos
    .filter((p) => p.status === "loading")
    .map((p) => p.file.name);
  const errorEntries = photos.filter((p) => p.metaError);

  const weatherDoneCount = photos.filter((p) => p.weatherStatus === "done").length;
  const weatherErrorCount = photos.filter((p) => p.weatherStatus === "error").length;
  const weatherLoadingNames = photos
    .filter((p) => p.weatherStatus === "loading")
    .map((p) => p.file.name);

  return (
    <div className="min-h-full bg-white text-neutral-900">
      <div className="mx-auto max-w-2xl px-4 pb-24 pt-10 sm:px-6">
        <header className="mb-8">
          <p className="text-xs font-medium tracking-wide text-neutral-400">
            LOOKIE
          </p>
          <h1 className="mt-1 text-xl font-semibold">
            사진 메타데이터 검증
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-neutral-500">
            거울셀카 여러 장을 선택하면 촬영 날짜와 GPS 정보를 브라우저에서
            바로 읽어옵니다. 사진은 저장되지 않고 이 기기에서만 처리됩니다.
          </p>
        </header>

        {/*
          iOS Safari에서는 label htmlFor + 별도 배치(1px/off-screen)된 input 조합에서
          change 이벤트가 아예 전달되지 않는 사례가 보고된다.
          가장 안전한 패턴은 "input을 버튼 위에 실제 크기로 겹쳐서" 탭이 곧바로
          input 자신에게 닿게 만드는 것 (opacity:0, position:absolute inset:0).
          display:none이 아니고, 크기도 0이 아니므로 iOS가 이벤트를 누락시키지 않는다.
        */}
        <label className="relative z-10 block w-full cursor-pointer select-none rounded-2xl bg-neutral-900 py-4 text-center text-sm font-medium text-white active:bg-neutral-700">
          사진 선택하기
          <input
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            onPointerUp={() => addLog("input 탭 감지 (pointerup)")}
            onChange={(e) => {
              addLog(`onChange 콜백 진입 (files=${e.target.files?.length ?? "null"})`);
              // handleFiles는 async 함수이므로, catch 없이 그냥 호출만 하면
              // 내부에서 던져진 예외가 아무 표시 없이 조용히 사라질 수 있다.
              // 반드시 catch를 붙여 디버그 로그로 드러낸다.
              handleFiles(e.target.files).catch((err) => {
                addLog(
                  `handleFiles 처리 중 최상위 예외: ${
                    err instanceof Error ? err.message : String(err)
                  }`
                );
              });
              e.target.value = "";
            }}
          />
        </label>

        {/*
          DEVELOPMENT ONLY — 이 디버그 패널은 iPhone Safari처럼 콘솔에 바로
          접근하기 어려운 환경에서 선택/메타데이터/날씨 조회 흐름을 눈으로
          확인하기 위한 임시 UI다. 실서비스(로그인/저장 기능 붙는 시점) 전에는
          제거하거나 관리자/개발자 전용 화면으로 옮길 것.
        */}
        <div className="mt-6 rounded-2xl border border-neutral-200 p-4">
          <p className="mb-3 text-xs font-semibold text-neutral-500">
            처리 상태 (디버그)
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div className="rounded-xl bg-neutral-50 py-2 text-center">
              <p className="text-base font-semibold">{lastSelectionCount}</p>
              <p className="text-neutral-500">선택된 파일</p>
            </div>
            <div className="rounded-xl bg-neutral-50 py-2 text-center">
              <p className="text-base font-semibold">{doneCount}/{total}</p>
              <p className="text-neutral-500">처리 완료</p>
            </div>
            <div className="rounded-xl bg-green-50 py-2 text-center">
              <p className="text-base font-semibold text-green-700">
                {successCount}
              </p>
              <p className="text-neutral-500">성공</p>
            </div>
            <div className="rounded-xl bg-red-50 py-2 text-center">
              <p className="text-base font-semibold text-red-700">
                {failCount}
              </p>
              <p className="text-neutral-500">실패</p>
            </div>
          </div>

          <p className="mt-3 text-xs text-neutral-500">
            현재 처리 중:{" "}
            <span className="text-neutral-700">
              {processingNames.length > 0
                ? processingNames.join(", ")
                : "없음"}
            </span>
          </p>

          <p className="mt-1 text-xs text-neutral-500">
            날씨 조회: 성공 {weatherDoneCount} · 실패 {weatherErrorCount} · 조회 중{" "}
            {weatherLoadingNames.length > 0 ? weatherLoadingNames.join(", ") : "없음"}
          </p>

          {errorEntries.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-semibold text-red-600">
                파일별 에러
              </p>
              <ul className="mt-1 space-y-1">
                {errorEntries.map((p) => (
                  <li key={p.id} className="text-xs text-red-600">
                    <span className="font-medium">{p.file.name}</span>:{" "}
                    {p.metaError}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-neutral-400">
              이벤트 로그 ({debugLog.length})
            </summary>
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-neutral-900 p-2 font-mono text-[10px] leading-relaxed text-neutral-100">
              {debugLog.length === 0 ? (
                <p className="text-neutral-500">아직 로그 없음</p>
              ) : (
                debugLog.map((line, i) => <p key={i}>{line}</p>)
              )}
            </div>
          </details>
        </div>

        <ul className="mt-6 flex flex-col gap-3">
          {photos.map((photo) => (
            <li
              key={photo.id}
              className="flex gap-3 rounded-2xl border border-neutral-100 p-3"
            >
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-neutral-100">
                {!photo.previewError && photo.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photo.previewUrl}
                    alt={photo.file.name}
                    className="h-full w-full object-cover"
                    onError={() => {
                      addLog(`[${photo.file.name}] 미리보기 렌더링 실패`);
                      setPhotos((prev) =>
                        prev.map((p) =>
                          p.id === photo.id
                            ? { ...p, previewError: true }
                            : p
                        )
                      );
                    }}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-neutral-400">
                    미리보기 불가
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate font-medium text-neutral-800">
                  {photo.file.name}
                </p>
                <p className="mt-0.5 text-[11px] text-neutral-400">
                  {photo.file.type || "형식 미상"} ·{" "}
                  {formatBytes(photo.file.size)}
                </p>

                {photo.status === "loading" ? (
                  <p className="mt-2 text-xs text-neutral-400">
                    메타데이터 확인 중…
                  </p>
                ) : (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs">
                      <span className="text-neutral-400">촬영 </span>
                      <span
                        className={
                          photo.hasDate
                            ? "text-neutral-700"
                            : "text-neutral-400"
                        }
                      >
                        {formatDate(photo.dateTimeOriginal)}
                      </span>
                    </p>
                    <p className="text-xs">
                      <span className="text-neutral-400">GPS </span>
                      <span
                        className={
                          photo.hasGps
                            ? "text-neutral-700"
                            : "text-neutral-400"
                        }
                      >
                        {formatGps(photo.latitude, photo.longitude)}
                      </span>
                    </p>
                    {photo.metaError && (
                      <p className="text-xs text-red-600">
                        파싱 에러: {photo.metaError}
                      </p>
                    )}

                    {/* 날씨 섹션 - 메타데이터와 시각적으로 구분되도록 구분선만 추가 */}
                    <div className="mt-2 border-t border-neutral-100 pt-2">
                      {photo.weatherStatus === "loading" && (
                        <p className="text-xs text-neutral-400">
                          날씨 조회 중…
                        </p>
                      )}
                      {(photo.weatherStatus === "no-date" ||
                        photo.weatherStatus === "no-gps" ||
                        photo.weatherStatus === "error") && (
                        <p className="text-xs text-neutral-400">
                          {photo.weatherMessage}
                        </p>
                      )}
                      {photo.weatherStatus === "done" && photo.weather && (
                        <div className="space-y-0.5 text-xs text-neutral-600">
                          <p className="font-medium text-neutral-700">
                            {photo.dateTimeOriginal
                              ? formatDateOnly(photo.dateTimeOriginal)
                              : ""}
                          </p>
                          <p className="text-neutral-400">
                            GPS {photo.latitude?.toFixed(4)},{" "}
                            {photo.longitude?.toFixed(4)} 인근
                          </p>
                          <p>
                            최고{" "}
                            {photo.weather.maxTemp !== null
                              ? `${photo.weather.maxTemp.toFixed(1)}℃`
                              : "정보 없음"}{" "}
                            · 최저{" "}
                            {photo.weather.minTemp !== null
                              ? `${photo.weather.minTemp.toFixed(1)}℃`
                              : "정보 없음"}
                          </p>
                          <p>
                            강수{" "}
                            {photo.weather.precipitationSum !== null
                              ? `${photo.weather.precipitationSum}mm`
                              : "정보 없음"}{" "}
                            · {photo.weather.weatherLabel}
                          </p>
                          {(photo.weather.meanTemp !== null ||
                            photo.weather.maxWindSpeed !== null) && (
                            <p className="text-neutral-400">
                              {photo.weather.meanTemp !== null &&
                                `평균 ${photo.weather.meanTemp.toFixed(1)}℃`}
                              {photo.weather.meanTemp !== null &&
                                photo.weather.maxWindSpeed !== null &&
                                " · "}
                              {photo.weather.maxWindSpeed !== null &&
                                `최대풍속 ${photo.weather.maxWindSpeed.toFixed(1)}km/h`}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>

        {total === 0 && (
          <p className="mt-10 text-center text-xs text-neutral-300">
            아직 선택한 사진이 없습니다
          </p>
        )}
      </div>
    </div>
  );
}
