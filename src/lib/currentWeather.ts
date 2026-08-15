// Open-Meteo Forecast API 연동 - 과거 사진용 fetchHistoricalWeather(weather.ts)와는
// 다른 엔드포인트다 (archive-api는 과거 날짜만 지원, 오늘/실시간은 forecast API).
// 풍속은 요청 파라미터에도 응답 매핑에도 넣지 않는다 - 이번 기능에서 쓰지 않기 때문.

import { describeWeatherCode } from "@/lib/weather";

export type TodayWeather = {
  /** 지금 이 순간의 실측 기온 - 화면 상단에 크게 보여주는 용도. */
  currentTemp: number | null;
  /** 오늘 하루 평균 예보기온 - 과거 룩의 tempMean과 비교하는 유사도 계산용. */
  tempMean: number | null;
  tempMax: number | null;
  tempMin: number | null;
  /** 0~100 (%). */
  precipitationProbability: number | null;
  precipitationSum: number | null;
  weatherCode: number | null;
  weatherLabel: string;
};

export async function fetchTodayWeather(latitude: number, longitude: number): Promise<TodayWeather> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", latitude.toFixed(4));
  url.searchParams.set("longitude", longitude.toFixed(4));
  url.searchParams.set("current", ["temperature_2m", "precipitation", "weathercode"].join(","));
  url.searchParams.set(
    "daily",
    [
      "temperature_2m_max",
      "temperature_2m_min",
      "temperature_2m_mean",
      "precipitation_sum",
      "precipitation_probability_max",
      "weathercode",
    ].join(",")
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Open-Meteo 응답 오류 (HTTP ${res.status})`);
  }

  const json = await res.json();
  const current = json?.current;
  const daily = json?.daily;
  if (!current && !daily) {
    throw new Error("오늘 날씨 데이터를 찾을 수 없음");
  }

  const weatherCode: number | null = current?.weathercode ?? daily?.weathercode?.[0] ?? null;

  return {
    currentTemp: current?.temperature_2m ?? null,
    tempMean: daily?.temperature_2m_mean?.[0] ?? null,
    tempMax: daily?.temperature_2m_max?.[0] ?? null,
    tempMin: daily?.temperature_2m_min?.[0] ?? null,
    precipitationProbability: daily?.precipitation_probability_max?.[0] ?? null,
    precipitationSum: daily?.precipitation_sum?.[0] ?? current?.precipitation ?? null,
    weatherCode,
    weatherLabel: describeWeatherCode(weatherCode),
  };
}
