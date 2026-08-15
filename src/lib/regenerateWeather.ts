"use client";

import { Timestamp } from "firebase/firestore";
import { fetchHistoricalWeatherForLook } from "@/lib/weather";
import { updateLookWeatherFields, type DbWeather } from "@/lib/lookStore";
import { toUsableDate } from "@/lib/format";

/**
 * 이미 저장된 룩의 takenAt(+ 있으면 GPS)로 Open-Meteo 과거 날씨를 다시
 * 조회해 weather/weatherStatus 필드만 덮어쓴다. 사진 원본·누끼·EXIF·lookId
 * 등은 전혀 다시 처리하지 않는다 - 상세 화면 "다시 조회" 버튼 전용.
 *
 * GPS가 없어도 실패로 취급하지 않는다 - fetchHistoricalWeatherForLook이
 * 업로드 때와 똑같이 "실제 좌표 있으면 그걸로, 없으면 서울로"를 처리하므로,
 * GPS 없이 실패 상태로 저장됐던 예전 룩도 사진 재업로드나 위치 직접 입력
 * 없이 복구된다.
 *
 * forceRefresh: true를 넘겨 weather.ts의 캐시를 무시하고 항상 새 요청을
 * 보낸다 - 이전에 실패했던 조회를 사용자가 명시적으로 재시도하는 경로이므로,
 * 캐시에 남아있을 수 있는 예전 결과를 절대 재사용하지 않는다.
 *
 * 촬영일이 없으면 애초에 조회할 날짜가 없어 조회가 불가능하므로 호출부가
 * 먼저 걸러야 한다(상세 화면에서 버튼 자체를 숨김) - 이 함수는 그 가정을
 * 다시 한번 방어적으로 검사만 하고 그대로 throw한다. 날짜 판별은
 * toUsableDate()로 하는데, 상세 화면 상단의 촬영일 표시와 완전히 같은
 * 기준이다 - "날짜는 화면에 뜨는데 날씨 쪽은 날짜가 없다고 한다" 같은
 * 불일치를 막기 위해 두 곳이 서로 다른 로직으로 각자 판단하지 않는다.
 */
export async function regenerateLookWeather(
  uid: string,
  look: { id: string; takenAt: Timestamp | null; latitude: number | null; longitude: number | null }
): Promise<void> {
  const takenAtDate = toUsableDate(look.takenAt);
  if (!takenAtDate) {
    throw new Error("촬영일 정보가 없어 날씨를 조회할 수 없어요");
  }

  const { result, locationSource } = await fetchHistoricalWeatherForLook(
    look.latitude,
    look.longitude,
    takenAtDate,
    {
      forceRefresh: true,
      logContext: { lookId: look.id, takenAt: takenAtDate.toISOString() },
    }
  );

  const weather: DbWeather = {
    weatherCode: result.weatherCode,
    weatherLabel: result.weatherLabel,
    tempMax: result.maxTemp,
    tempMin: result.minTemp,
    tempMean: result.meanTemp,
    precipitation: result.precipitationSum,
    windMax: result.maxWindSpeed,
    locationSource,
  };

  await updateLookWeatherFields(uid, look.id, { weather, weatherStatus: "success" });
}
