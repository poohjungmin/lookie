"use client";

import type { DisplayLook } from "@/lib/useLocalFirstLooks";
import { resolveLookDate } from "@/lib/lookDate";
import { fetchHistoricalWeatherForLook } from "@/lib/weather";
import { updateLookWeatherFields, toDbWeather, type DbWeather, type DbWeatherStatus } from "@/lib/lookStore";

// 한 번에 이 개수만큼만 동시에 조회한다 - 무제한 병렬 호출로 Open-Meteo를
// 한꺼번에 두드리지 않는다. 같은 날짜/좌표는 weather.ts 캐시가 자연히
// 하나의 요청으로 합쳐주므로, 서로 다른 날짜/위치의 룩들만 동시에 나간다.
const BULK_CONCURRENCY = 4;

/**
 * 이 룩에 "정상적으로 쓸 수 있는" weather가 있는지. 정상이 아니면(weather
 * 자체가 없거나, weatherStatus가 success가 아니거나, weather는 있어도
 * 추천 계산에 쓰는 핵심 기온 수치가 전부 비어있으면) 일괄 재조회 대상이다.
 * 이미 정상 weather가 있는 룩은 절대 건드리지 않는다.
 */
export function isWeatherMissing(look: Pick<DisplayLook, "weatherStatus" | "weather">): boolean {
  if (look.weatherStatus !== "success") return true;
  if (!look.weather) return true;
  const w = look.weather;
  if (w.tempMean === null && w.tempMax === null && w.tempMin === null) return true;
  return false;
}

export type BulkWeatherRecoveryProgress = { done: number; total: number };

export type BulkWeatherRecoveryResult = {
  succeeded: number;
  failed: number;
  /** 촬영일 자체가 없어(resolveLookDate가 null) 애초에 조회를 시도하지 못한 개수. */
  skippedNoDate: number;
};

/**
 * weather가 없는 룩들만(호출부가 isWeatherMissing으로 미리 걸러서 넘긴다)
 * concurrency를 제한해 순차적으로 처리한다. 한 룩이 실패해도 나머지는
 * 계속 진행하고, 성공한 것만 Firestore weather 필드를 패치한다 - 사진
 * 재업로드/원본 다운로드/썸네일/누끼 재생성/EXIF 재추출은 전혀 하지 않는다.
 *
 * 개별 재조회(regenerateWeather.ts)와 날짜 결정(resolveLookDate)·위치
 * fallback·재시도·weather 매핑(toDbWeather) 로직을 전부 공유한다 - 다른
 * 점은 여기서는 forceRefresh를 쓰지 않는다는 것뿐이다(동일 날짜/좌표의
 * 여러 룩이 weather.ts의 Promise 캐시를 그대로 공유해 중복 호출을 줄이게
 * 하기 위해 - 캐시에 남은 실패 Promise는 이미 자동으로 제거된다).
 */
export async function recoverMissingWeather(
  uid: string,
  missingLooks: DisplayLook[],
  callbacks: {
    onProgress?: (progress: BulkWeatherRecoveryProgress) => void;
    onLookRecovered?: (lookId: string, weather: DbWeather, weatherStatus: DbWeatherStatus) => void;
  } = {}
): Promise<BulkWeatherRecoveryResult> {
  const total = missingLooks.length;
  let done = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedNoDate = 0;

  callbacks.onProgress?.({ done: 0, total });

  let cursor = 0;
  async function worker() {
    while (cursor < missingLooks.length) {
      const look = missingLooks[cursor];
      cursor++;

      const takenAtDate = resolveLookDate(look);
      if (!takenAtDate) {
        skippedNoDate++;
      } else {
        try {
          const { result, locationSource } = await fetchHistoricalWeatherForLook(
            look.latitude,
            look.longitude,
            takenAtDate,
            { logContext: { lookId: look.id, takenAt: takenAtDate.toISOString(), bulk: true } }
          );
          const weather = toDbWeather(result, locationSource);
          await updateLookWeatherFields(uid, look.id, { weather, weatherStatus: "success" });
          succeeded++;
          callbacks.onLookRecovered?.(look.id, weather, "success");
        } catch {
          failed++;
        }
      }

      done++;
      callbacks.onProgress?.({ done, total });
    }
  }

  const workerCount = Math.min(BULK_CONCURRENCY, Math.max(1, missingLooks.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { succeeded, failed, skippedNoDate };
}
