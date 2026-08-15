"use client";

import { Timestamp } from "firebase/firestore";
import { fetchHistoricalWeather } from "@/lib/weather";
import { updateLookWeatherFields, type DbWeather } from "@/lib/lookStore";

/**
 * 이미 저장된 룩의 takenAt/GPS로 Open-Meteo 과거 날씨를 다시 조회해
 * weather/weatherStatus 필드만 덮어쓴다. 사진 원본·누끼·EXIF·lookId 등은
 * 전혀 다시 처리하지 않는다 - 상세 화면 "다시 조회" 버튼 전용.
 *
 * forceRefresh: true를 넘겨 weather.ts의 캐시를 무시하고 항상 새 요청을
 * 보낸다 - 이전에 실패했던 조회를 사용자가 명시적으로 재시도하는 경로이므로,
 * 캐시에 남아있을 수 있는 예전 결과를 절대 재사용하지 않는다.
 *
 * takenAt/GPS 중 하나라도 없으면 애초에 조회가 불가능하므로 호출부가 먼저
 * 걸러야 한다(상세 화면에서 버튼 자체를 숨김) - 이 함수는 그 가정을 다시
 * 한번 방어적으로 검사만 하고 그대로 throw한다.
 */
export async function regenerateLookWeather(
  uid: string,
  look: { id: string; takenAt: Timestamp | null; latitude: number | null; longitude: number | null }
): Promise<void> {
  if (!look.takenAt || look.latitude === null || look.longitude === null) {
    throw new Error("촬영일 또는 위치 정보가 없어 날씨를 조회할 수 없어요");
  }

  const result = await fetchHistoricalWeather(look.latitude, look.longitude, look.takenAt.toDate(), {
    forceRefresh: true,
    logContext: { lookId: look.id, takenAt: look.takenAt.toDate().toISOString() },
  });

  const weather: DbWeather = {
    weatherCode: result.weatherCode,
    weatherLabel: result.weatherLabel,
    tempMax: result.maxTemp,
    tempMin: result.minTemp,
    tempMean: result.meanTemp,
    precipitation: result.precipitationSum,
    windMax: result.maxWindSpeed,
  };

  await updateLookWeatherFields(uid, look.id, { weather, weatherStatus: "success" });
}
