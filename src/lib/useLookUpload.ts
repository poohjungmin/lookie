"use client";

import { useState } from "react";
import { Timestamp } from "firebase/firestore";
import { extractPhotoMetadataSafe } from "@/lib/exif";
import { fetchHistoricalWeatherForLook, type WeatherResult, type WeatherLocationSource } from "@/lib/weather";
import {
  computeFingerprint,
  lookAlreadyExists,
  uploadLookPhoto,
  uploadLookThumbnail,
  uploadLookCutout,
  uploadLookCutoutThumbnail,
  saveLookRecord,
  toDbWeather,
  type DbWeather,
  type DbWeatherStatus,
} from "@/lib/lookStore";
import { generateThumbnail } from "@/lib/thumbnail";
import { generateCutout, CURRENT_CUTOUT_VERSION } from "@/lib/cutout";
import { cacheKeyOf, putCachedLook } from "@/lib/lookCache";
import { getPersonalCorrectionProfile } from "@/lib/personalCropHeuristic";

type WeatherStage = "no-date" | "done" | "error";
export type SaveStage =
  | "idle"
  | "uploading-photo"
  | "generating-cutout"
  | "saving-record"
  | "saved"
  | "duplicate"
  | "error";

export type UploadItem = {
  id: string;
  file: File;
  previewUrl: string;
  saveStage: SaveStage;
};

function toDbWeatherStatus(stage: WeatherStage): DbWeatherStatus {
  if (stage === "done") return "success";
  if (stage === "error") return "failed";
  return "missing_metadata"; // no-date - GPS 없음은 더 이상 실패 사유가 아니다(서울 fallback)
}

/**
 * STEP 1~3에서 만든 업로드 파이프라인(메타데이터 추출 → 날씨 조회 →
 * Storage 업로드 → Firestore 기록, 파일별 독립 처리 + 중복 방지)을
 * 그대로 재사용하는 훅. UI(진행 상태 표시)만 화면마다 다르게 그린다.
 *
 * local-first 캐시 개선: 원본과 별도로 목록용 WebP 썸네일을 생성/업로드하고,
 * 저장이 끝나자마자 이미 메모리에 있는 썸네일 Blob을 바로 IndexedDB에 써서
 * 다음 동기화 때 다시 내려받지 않게 한다.
 */
export function useLookUpload(uid: string, onSaved: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);

  function updateItem(id: string, patch: Partial<UploadItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  // 파일 하나의 처리는 완전히 독립적이다. 어디서 실패하든 이 함수 밖으로
  // 예외가 새어나가지 않으므로, 여러 장을 Promise.allSettled로 동시에
  // 돌려도 한 장의 실패가 다른 장의 처리를 막지 않는다.
  async function processOne(item: UploadItem) {
    try {
      const meta = await extractPhotoMetadataSafe(item.file);

      // GPS가 없어도 실패로 취급하지 않는다 - fetchHistoricalWeatherForLook이
      // 내부에서 "실제 좌표 있으면 그걸로, 없으면 서울로"를 한 번에 처리한다.
      // 촬영일 자체가 없는 경우만 애초에 조회할 날짜가 없어 건너뛴다.
      let weather: WeatherResult | null = null;
      let weatherLocationSource: WeatherLocationSource | null = null;
      let weatherStage: WeatherStage;
      if (!meta.hasDate) {
        weatherStage = "no-date";
      } else {
        try {
          const { result, locationSource } = await fetchHistoricalWeatherForLook(
            meta.latitude,
            meta.longitude,
            meta.dateTimeOriginal as Date
          );
          weather = result;
          weatherLocationSource = locationSource;
          weatherStage = "done";
        } catch {
          weatherStage = "error";
        }
      }

      const fingerprint = await computeFingerprint(item.file, meta.dateTimeOriginal);

      const exists = await lookAlreadyExists(uid, fingerprint);
      if (exists) {
        updateItem(item.id, { saveStage: "duplicate" });
        return;
      }

      updateItem(item.id, { saveStage: "uploading-photo" });
      // 원본 업로드와 썸네일 생성은 서로 무관하니 동시에 진행한다.
      // 썸네일 생성이 실패해도(구형 브라우저 등) 원본 저장은 그대로 진행된다.
      const [{ imageUrl, storagePath }, thumbBlob] = await Promise.all([
        uploadLookPhoto(uid, fingerprint, item.file),
        generateThumbnail(item.file),
      ]);

      let thumbnailUrl: string | null = null;
      let thumbnailStoragePath: string | null = null;
      if (thumbBlob) {
        try {
          const result = await uploadLookThumbnail(uid, fingerprint, thumbBlob);
          thumbnailUrl = result.thumbnailUrl;
          thumbnailStoragePath = result.thumbnailStoragePath;
        } catch {
          // 썸네일 업로드 실패 - 원본은 이미 있으니 imageUrl로 폴백하며 계속 진행
        }
      }

      // 사람 전체 누끼 생성 - 실패해도(모델 로드 실패, 메모리 부족 등) 룩
      // 저장 자체는 그대로 진행되고, 화면에는 원본/썸네일로 자연스럽게
      // 폴백된다. 나중에 /dev/cutout-migrate에서 다시 시도할 수 있다.
      // personalCorrections는 세션당 한 번만 Firestore에서 읽고 캐시되므로
      // (getPersonalCorrectionProfile 내부 캐시), 같은 배치의 여러 장을
      // 동시에 처리해도 사진마다 추가 네트워크 호출이 생기지 않는다.
      updateItem(item.id, { saveStage: "generating-cutout" });
      const personalCorrections = await getPersonalCorrectionProfile(uid);
      const cutout = await generateCutout(item.file, personalCorrections);

      let cutoutUrl: string | null = null;
      let cutoutStoragePath: string | null = null;
      let cutoutThumbnailUrl: string | null = null;
      let cutoutThumbnailStoragePath: string | null = null;
      let cutoutVersion: number | null = null;
      if (cutout) {
        try {
          const [detail, thumb] = await Promise.all([
            uploadLookCutout(uid, fingerprint, cutout.detailBlob),
            uploadLookCutoutThumbnail(uid, fingerprint, cutout.thumbBlob),
          ]);
          cutoutUrl = detail.cutoutUrl;
          cutoutStoragePath = detail.cutoutStoragePath;
          cutoutThumbnailUrl = thumb.cutoutThumbnailUrl;
          cutoutThumbnailStoragePath = thumb.cutoutThumbnailStoragePath;
          cutoutVersion = CURRENT_CUTOUT_VERSION;
        } catch {
          // 업로드 실패 - 원본/썸네일로 폴백하며 계속 진행
        }
      }

      const weatherPayload: DbWeather | null = weather
        ? toDbWeather(weather, weatherLocationSource ?? "exif")
        : null;
      const weatherStatus = toDbWeatherStatus(weatherStage);

      updateItem(item.id, { saveStage: "saving-record" });
      await saveLookRecord(uid, fingerprint, {
        imageUrl,
        storagePath,
        thumbnailUrl,
        thumbnailStoragePath,
        cutoutUrl,
        cutoutStoragePath,
        cutoutThumbnailUrl,
        cutoutThumbnailStoragePath,
        cutoutVersion,
        lastAutoCropRatio: cutout?.autoCrop?.bboxRatio ?? null,
        originalFileName: item.file.name,
        takenAt: meta.dateTimeOriginal ? Timestamp.fromDate(meta.dateTimeOriginal) : null,
        latitude: meta.latitude,
        longitude: meta.longitude,
        weather: weatherPayload,
        weatherStatus,
        category: null,
        dressLevel: null,
        aiAnalysis: null,
        fingerprint,
      });

      // 이미 메모리에 썸네일/누끼 Blob이 있으니, 다음 동기화 때 다시
      // 내려받지 않도록 지금 바로 로컬 캐시에 반영한다.
      await putCachedLook({
        cacheKey: cacheKeyOf(uid, fingerprint),
        uid,
        lookId: fingerprint,
        imageUrl,
        thumbnailUrl,
        cutoutUrl,
        cutoutThumbnailUrl,
        cutoutVersion,
        lastAutoCropRatio: cutout?.autoCrop?.bboxRatio ?? null,
        takenAtMs: meta.dateTimeOriginal ? meta.dateTimeOriginal.getTime() : null,
        latitude: meta.latitude,
        longitude: meta.longitude,
        weatherStatus,
        weather: weatherPayload,
        updatedAtMs: Date.now(),
        thumbBlob,
        thumbType: thumbBlob?.type ?? null,
        cutoutThumbBlob: cutout?.thumbBlob ?? null,
        cutoutThumbType: cutout?.thumbBlob.type ?? null,
        cachedAt: Date.now(),
      });

      updateItem(item.id, { saveStage: "saved" });
      onSaved();
    } catch {
      updateItem(item.id, { saveStage: "error" });
    }
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);

    const initial: UploadItem[] = files.map((file) => {
      let previewUrl = "";
      try {
        previewUrl = URL.createObjectURL(file);
      } catch {
        previewUrl = "";
      }
      return {
        id: `${file.name}-${file.lastModified}-${file.size}-${Math.random()
          .toString(36)
          .slice(2)}`,
        file,
        previewUrl,
        saveStage: "idle",
      };
    });

    setItems((prev) => [...prev, ...initial]);

    // 파일별로 독립적인 프로미스를 동시에 시작한다 (순차 await 아님).
    await Promise.allSettled(initial.map(processOne));
  }

  const total = items.length;
  const savedCount = items.filter((i) => i.saveStage === "saved").length;
  const duplicateCount = items.filter((i) => i.saveStage === "duplicate").length;
  const errorCount = items.filter((i) => i.saveStage === "error").length;
  const doneCount = savedCount + duplicateCount + errorCount;

  return { items, handleFiles, total, doneCount, savedCount, duplicateCount, errorCount };
}
