"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";
import { resolveLookDate } from "@/lib/lookDate";
import { regenerateLookCutoutFromCrop } from "@/lib/regenerateCutout";
import { regenerateLookWeather } from "@/lib/regenerateWeather";
import { downloadOriginalWithFallbacks } from "@/lib/cutoutDownload";
import { saveManualCropCorrection } from "@/lib/personalCropHeuristic";
import ManualCutoutCropModal, { type ManualCropResult } from "@/components/ManualCutoutCropModal";
import LookDetailGallery from "@/components/LookDetailGallery";

/**
 * 뒤로가기 목적지를 URL 쿼리(from/year/month)로부터 계산한다. 실제 브라우저
 * 히스토리 유무에 기대는 router.back() 대신, 출처 정보로부터 항상 같은
 * 목적지 URL을 만들어 Link로 이동한다 - PWA를 새로 열어 상세로 바로
 * 진입했거나(히스토리가 없음) 새로고침한 경우에도 결과가 예측 가능하다.
 * 출처 정보가 없으면 전체 룩으로 폴백한다.
 */
function resolveBackHref(searchParams: URLSearchParams): string {
  const from = searchParams.get("from");
  if (from === "calendar") {
    const year = searchParams.get("year");
    const month = searchParams.get("month");
    if (year && month) return `/history?year=${year}&month=${month}`;
    return "/history";
  }
  if (from === "home") return "/";
  if (from === "looks") {
    // "기온으로 찾기" 검색 결과에서 들어왔다면 검색 조건까지 그대로 복원한다.
    if (searchParams.get("mode") === "weather") {
      const max = searchParams.get("max");
      const min = searchParams.get("min");
      const rain = searchParams.get("rain") ?? "any";
      if (max !== null && min !== null) {
        return `/looks?mode=weather&max=${encodeURIComponent(max)}&min=${encodeURIComponent(min)}&rain=${encodeURIComponent(rain)}`;
      }
    }
    return "/looks";
  }
  return "/looks";
}

function LookDetailPageInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, looks, syncing, deleteLook, refreshSingleLook, patchLookWeather } = useApp();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 누끼 수정: "누끼 수정" 탭 -> 원본 로딩 -> 자유 크롭 모달 -> 크롭 결과로 재생성.
  const [cropLoading, setCropLoading] = useState(false);
  const [cropOriginalBlob, setCropOriginalBlob] = useState<Blob | null>(null);
  const [cropBusy, setCropBusy] = useState(false);
  const [cropError, setCropError] = useState<string | null>(null);
  const [cropDone, setCropDone] = useState(false);

  // 날씨 다시 조회: 촬영일/GPS는 이미 저장돼 있고 API 조회만 실패했던 룩을
  // 사진 재업로드 없이 복구한다.
  const [weatherRetrying, setWeatherRetrying] = useState(false);
  const [weatherRetryError, setWeatherRetryError] = useState<string | null>(null);

  const backHref = resolveBackHref(searchParams);
  const look = looks.find((l) => l.id === id);

  if (!look) {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
        <p className="text-sm text-neutral-400">
          {syncing ? "불러오는 중…" : "룩을 찾을 수 없습니다"}
        </p>
        <Link
          href={backHref}
          className="mt-4 inline-block text-sm text-neutral-500 underline underline-offset-2"
        >
          돌아가기
        </Link>
      </div>
    );
  }

  // 상세 화면 최상단 촬영일 표시와 날씨 "다시 조회" 가능 여부 판단이
  // 서로 다른 기준을 쓰면(예: 날짜는 뜨는데 날씨 쪽은 날짜가 없다고 하는 등)
  // 불일치가 생긴다 - 두 곳 모두 이 값 하나만 쓰게 한다. takenAt이
  // weatherStatus 필드가 도입되기 전/GPS 요구사항이 바뀌기 전에 저장된
  // 예전 룩("missing_metadata"로 굳어있지만 실제로는 유효한 촬영일이 있는
  // 경우)도 여기서 함께 구제된다 - weatherStatus 값 자체가 아니라 실제
  // 촬영일 존재 여부로 재조회 가능 여부를 판단하기 때문.
  const takenAtDate = resolveLookDate(look);

  // 자동 정규화가 사람을 잘못 판단한 예외 사진을 사용자가 직접 보정하는
  // 유일한 경로. 원본을 먼저 불러온 뒤 크롭 모달을 띄우고, 사용자가 고른
  // 영역만 배경 제거 + 정규화 파이프라인에 넣는다.
  async function handleStartManualCrop() {
    if (!look) return;
    setCropError(null);
    setCropDone(false);
    setCropLoading(true);
    try {
      const { blob } = await downloadOriginalWithFallbacks(
        user.uid,
        look.id,
        look.storagePath,
        look.imageUrl
      );
      setCropOriginalBlob(blob);
    } catch (err) {
      setCropError(
        `원본을 불러오지 못했어요: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setCropLoading(false);
    }
  }

  async function handleConfirmCrop(result: ManualCropResult) {
    if (!look) return;
    setCropBusy(true);
    setCropError(null);
    try {
      await regenerateLookCutoutFromCrop(user.uid, look.id, result.croppedBlob);

      // "personal crop correction heuristic" 학습용 기록 - 자동으로 잡혔던
      // 영역(lastAutoCropRatio, 최근 자동 생성 시점에 저장돼있음)과 방금
      // 사용자가 최종 지정한 영역의 차이를 저장한다. 이전 버전에서 생성돼
      // 자동 crop 기준이 없는 룩은(lastAutoCropRatio가 null) 비교 기준이
      // 없으므로 기록을 남기지 않는다 - 누끼 재생성 자체는 이미 끝났으니
      // 이 저장이 실패해도(오프라인 등) 사용자 경험에는 영향 없다.
      if (look.lastAutoCropRatio) {
        const manualCropRatio = {
          x: result.manualCropPixels.x / result.naturalWidth,
          y: result.manualCropPixels.y / result.naturalHeight,
          width: result.manualCropPixels.width / result.naturalWidth,
          height: result.manualCropPixels.height / result.naturalHeight,
        };
        saveManualCropCorrection(user.uid, look.id, {
          originalImageWidth: result.naturalWidth,
          originalImageHeight: result.naturalHeight,
          autoCropRatio: look.lastAutoCropRatio,
          manualCropRatio,
        }).catch(() => {
          // 개인화 기록 저장 실패는 조용히 무시 - 누끼 재생성은 이미 성공했다.
          // 실패 이유 자체는 saveManualCropCorrection 내부에서 이미
          // [manual-crop-correction] 로그로 남겼다(개발 환경 한정).
        });
      } else if (process.env.NODE_ENV !== "production") {
        console.log(
          ["[manual-crop-correction]", "saved: false", `lookId: ${look.id}`, "autoCrop available: false", "reason: lastAutoCropRatio missing"].join(
            "\n"
          )
        );
      }

      // 목록 전체를 다시 훑지 않고 이 룩 하나만 즉시 최신 상태로 갱신한다 -
      // 상세 화면 1페이지 누끼/홈/캘린더/전체 룩이 별도 새로고침 없이 바로
      // 새 누끼를 보여준다 (IndexedDB/React state/object URL/cache busting은
      // refreshSingleLook 내부에서 기존 구조 그대로 처리된다).
      await refreshSingleLook(look.id);
      setCropOriginalBlob(null);
      setCropDone(true);
    } catch (err) {
      setCropError(err instanceof Error ? err.message : String(err));
    } finally {
      setCropBusy(false);
    }
  }

  // 촬영일/GPS는 이미 저장돼 있고 API 조회만 실패했던 룩을 사진 재업로드
  // 없이 복구한다. 성공하면 이 룩 하나만 즉시 갱신해서(기존 refreshSingleLook
  // 재사용) IndexedDB/React state가 그대로 업데이트되고, 홈 추천 계산도
  // 다음 렌더에서 자연스럽게 새 weather를 반영한다.
  async function handleRetryWeather() {
    if (!look) return;
    setWeatherRetrying(true);
    setWeatherRetryError(null);
    try {
      const weather = await regenerateLookWeather(user.uid, look);
      // 이미지가 전혀 바뀌지 않았으니 캐시된 썸네일/누끼를 무효화하는
      // refreshSingleLook 대신, weather 필드만 가볍게 갱신한다.
      patchLookWeather(look.id, weather, "success");
    } catch {
      setWeatherRetryError("다시 조회하지 못했어요.");
    } finally {
      setWeatherRetrying(false);
    }
  }

  async function handleConfirmDelete() {
    if (!look) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteLook(look.id);
      // 목록/캘린더/홈은 공용 Context 상태를 쓰므로 삭제 즉시 거기서도 사라진다.
      router.replace(backHref);
    } catch (err) {
      setDeleting(false);
      setDeleteError(
        `삭제에 실패했어요: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <div className="relative">
        <Link
          href={backHref}
          aria-label="뒤로"
          className="absolute left-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow"
        >
          ←
        </Link>
        <button
          type="button"
          onClick={() => {
            setDeleteError(null);
            setConfirmOpen(true);
          }}
          aria-label="룩 삭제"
          className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow"
        >
          {/* 휴지통 아이콘 */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16" />
            <path d="M9 7V4h6v3" />
            <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
        <LookDetailGallery look={look} />
      </div>

      <div className="px-5 pt-6 sm:px-6">
        <p className="text-lg font-semibold text-neutral-900">
          {takenAtDate ? formatDateOnly(takenAtDate) : "촬영일 정보 없음"}
        </p>

        <div className="mt-4 rounded-2xl bg-neutral-50 p-5">
          {look.weatherStatus === "success" && look.weather ? (
            <div className="space-y-1.5 text-sm text-neutral-600">
              <p className="text-base font-medium text-neutral-800">
                {look.weather.weatherLabel ?? "-"}
                {look.weather.locationSource === "fallback-seoul" && (
                  <span className="ml-1.5 text-xs font-normal text-neutral-300">서울 기준</span>
                )}
              </p>
              <p>
                최고{" "}
                {look.weather.tempMax !== null
                  ? `${look.weather.tempMax.toFixed(1)}℃`
                  : "-"}{" "}
                · 최저{" "}
                {look.weather.tempMin !== null
                  ? `${look.weather.tempMin.toFixed(1)}℃`
                  : "-"}
              </p>
              <p className="text-neutral-400">
                강수{" "}
                {look.weather.precipitation !== null
                  ? `${look.weather.precipitation}mm`
                  : "정보 없음"}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-sm text-neutral-400">
                {takenAtDate
                  ? look.weatherStatus === "failed"
                    ? "날씨 조회에 실패했어요"
                    : "아직 날씨 정보가 없어요"
                  : "날씨 조회에 필요한 촬영일 정보가 없어요."}
              </p>
              {/* weatherStatus 값과 무관하게, 화면 상단에 뜬 것과 같은 기준의
                  유효한 촬영일(takenAtDate)이 있으면 다시 조회할 수 있게 한다 -
                  예전에 GPS가 없어 "missing_metadata"로 굳어버린 룩도 촬영일만
                  있으면 이 버튼으로 서울 기준 날씨를 복구할 수 있다. */}
              {takenAtDate && (
                <>
                  <button
                    type="button"
                    onClick={handleRetryWeather}
                    disabled={weatherRetrying}
                    className="mt-2 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 disabled:opacity-50"
                  >
                    {weatherRetrying ? "날씨 조회 중…" : "다시 조회"}
                  </button>
                  {weatherRetryError && (
                    <p className="mt-2 text-xs text-red-600">{weatherRetryError}</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* 별도 누끼 미리보기 카드는 제거했다 - 위 갤러리 1페이지에서 이미
            누끼를 크게 보여주므로 중복이다. 수정 버튼만 남긴다. */}
        <button
          type="button"
          onClick={handleStartManualCrop}
          disabled={cropLoading || cropBusy}
          className="mt-4 w-full rounded-xl border border-neutral-300 py-2.5 text-center text-sm font-medium text-neutral-800 disabled:opacity-50"
        >
          {cropLoading ? "원본 불러오는 중…" : "✂️ 누끼 수정"}
        </button>
        {cropDone && (
          <p className="mt-2 text-center text-xs text-neutral-500">다시 생성했어요.</p>
        )}
        {cropError && (
          <p className="mt-2 text-center text-xs text-red-600">실패: {cropError}</p>
        )}

        {/* 향후 카테고리·꾸밈 정도 표시 공간 (Vision AI 붙기 전까지는 비워둠) */}
        <div className="mt-4 rounded-2xl border border-dashed border-neutral-200 p-5 text-center text-xs text-neutral-300">
          카테고리 · 꾸밈 정도 (준비 중)
        </div>
      </div>

      {/* 삭제 확인 모달 - 실수 방지를 위해 상세화면 → 삭제 아이콘 → 확인,
          반드시 2단계를 거치게 한다 (탭 한 번으로 바로 삭제하지 않음). */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-sm rounded-t-3xl bg-white p-6 sm:rounded-3xl">
            <p className="text-base font-semibold text-neutral-900">
              이 룩을 삭제할까요?
            </p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-500">
              사진과 해당 날짜의 룩 기록이 모두 삭제됩니다.
            </p>
            {deleteError && (
              <p className="mt-3 text-xs text-red-600">{deleteError}</p>
            )}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium text-neutral-700 disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:bg-red-300"
              >
                {deleting ? "삭제 중…" : "삭제"}
              </button>
            </div>
          </div>
        </div>
      )}

      {cropOriginalBlob && (
        <ManualCutoutCropModal
          imageBlob={cropOriginalBlob}
          busy={cropBusy}
          onCancel={() => {
            if (cropBusy) return;
            setCropOriginalBlob(null);
          }}
          onConfirm={handleConfirmCrop}
        />
      )}
    </div>
  );
}

export default function LookDetailPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
          <p className="text-sm text-neutral-400">불러오는 중…</p>
        </div>
      }
    >
      <LookDetailPageInner />
    </Suspense>
  );
}
