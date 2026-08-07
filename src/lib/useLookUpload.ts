"use client";

import { useState } from "react";
import { Timestamp } from "firebase/firestore";
import { extractPhotoMetadataSafe } from "@/lib/exif";
import { fetchHistoricalWeather, type WeatherResult } from "@/lib/weather";
import {
  computeFingerprint,
  lookAlreadyExists,
  uploadLookPhoto,
  saveLookRecord,
  type DbWeatherStatus,
} from "@/lib/lookStore";

type WeatherStage = "no-date" | "no-gps" | "done" | "error";
export type SaveStage =
  | "idle"
  | "uploading-photo"
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
  return "missing_metadata"; // no-date, no-gps
}

/**
 * STEP 1~3에서 만든 업로드 파이프라인(메타데이터 추출 → 날씨 조회 →
 * Storage 업로드 → Firestore 기록, 파일별 독립 처리 + 중복 방지)을
 * 그대로 재사용하는 훅. UI(진행 상태 표시)만 화면마다 다르게 그린다.
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

      let weather: WeatherResult | null = null;
      let weatherStage: WeatherStage;
      if (!meta.hasDate) {
        weatherStage = "no-date";
      } else if (!meta.hasGps) {
        weatherStage = "no-gps";
      } else {
        try {
          weather = await fetchHistoricalWeather(
            meta.latitude as number,
            meta.longitude as number,
            meta.dateTimeOriginal as Date
          );
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
      const { imageUrl, storagePath } = await uploadLookPhoto(uid, fingerprint, item.file);

      updateItem(item.id, { saveStage: "saving-record" });
      await saveLookRecord(uid, fingerprint, {
        imageUrl,
        storagePath,
        originalFileName: item.file.name,
        takenAt: meta.dateTimeOriginal ? Timestamp.fromDate(meta.dateTimeOriginal) : null,
        latitude: meta.latitude,
        longitude: meta.longitude,
        weather: weather
          ? {
              weatherCode: weather.weatherCode,
              weatherLabel: weather.weatherLabel,
              tempMax: weather.maxTemp,
              tempMin: weather.minTemp,
              tempMean: weather.meanTemp,
              precipitation: weather.precipitationSum,
              windMax: weather.maxWindSpeed,
            }
          : null,
        weatherStatus: toDbWeatherStatus(weatherStage),
        category: null,
        dressLevel: null,
        aiAnalysis: null,
        fingerprint,
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
