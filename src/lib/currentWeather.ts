// Open-Meteo Forecast API 연동 - 과거 사진용 fetchHistoricalWeather(weather.ts)와는
// 다른 엔드포인트다 (archive-api는 과거 날짜만 지원, 오늘/미래는 forecast API).
// 풍속은 요청 파라미터에도 응답 매핑에도 넣지 않는다 - 이번 기능에서 쓰지 않기 때문.

import { describeWeatherCode } from "@/lib/weather";

// 오늘 포함 앞으로 이만큼의 날짜를 한 번의 요청으로 받는다 - 홈 화면에서
// 날짜를 넘길 때마다 Open-Meteo를 다시 부르지 않기 위해, 처음부터 필요한
// 만큼을 한 번에 받아 상태에 저장해두고 재사용한다.
const FORECAST_DAYS = 7;

/** 하루치 날씨 - 과거 룩의 weather와 같은 모양(tempMean/tempMax/tempMin/precipitation/weatherCode)이라
 * weatherSimilarity.ts의 유사도 계산 입력으로 그대로 쓸 수 있다. */
export type DailyWeather = {
  tempMean: number | null;
  tempMax: number | null;
  tempMin: number | null;
  /** 0~100 (%). */
  precipitationProbability: number | null;
  precipitationSum: number | null;
  weatherCode: number | null;
  weatherLabel: string;
};

/** DailyWeather + 지금 이 순간의 실측 기온(오늘만 값이 있고, 미래 날짜는 null). */
export type TodayWeather = DailyWeather & {
  currentTemp: number | null;
};

/** 예보 하루치 카드 표시에 필요한 값 전부. */
export type ForecastDay = TodayWeather & {
  /** "YYYY-MM-DD" (Open-Meteo daily.time 그대로). */
  date: string;
  /** 0 = 오늘, 1 = 내일, 2~6 = 그 이후. */
  dayOffset: number;
};

export type WeeklyForecast = {
  /** 오늘 포함 최대 FORECAST_DAYS일, days[0]이 항상 오늘. */
  days: ForecastDay[];
};

/**
 * 오늘 날씨 + 앞으로 며칠 예보를 한 번의 Open-Meteo 요청으로 가져온다.
 * 이전에는 forecast_days=1로 오늘만 받았는데, daily 배열을 여러 날짜로
 * 늘리기만 하면 오늘 날씨도 그대로 포함되므로(days[0]) 별도로 "오늘 날씨"를
 * 중복 호출할 필요가 없다.
 */
export async function fetchWeeklyForecast(latitude: number, longitude: number): Promise<WeeklyForecast> {
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
  url.searchParams.set("forecast_days", String(FORECAST_DAYS));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Open-Meteo 응답 오류 (HTTP ${res.status})`);
  }

  const json = await res.json();
  const current = json?.current;
  const daily = json?.daily;
  const times: string[] = Array.isArray(daily?.time) ? daily.time : [];
  if (!current && times.length === 0) {
    throw new Error("이번 주 날씨 데이터를 찾을 수 없음");
  }

  const days: ForecastDay[] = times.map((date, i) => {
    const weatherCode: number | null = daily?.weathercode?.[i] ?? null;
    const isToday = i === 0;
    return {
      date,
      dayOffset: i,
      // "지금 이 순간" 실측값은 Open-Meteo가 오늘에 대해서만 준다.
      currentTemp: isToday ? current?.temperature_2m ?? null : null,
      tempMean: daily?.temperature_2m_mean?.[i] ?? null,
      tempMax: daily?.temperature_2m_max?.[i] ?? null,
      tempMin: daily?.temperature_2m_min?.[i] ?? null,
      precipitationProbability: daily?.precipitation_probability_max?.[i] ?? null,
      precipitationSum: daily?.precipitation_sum?.[i] ?? (isToday ? current?.precipitation ?? null : null),
      weatherCode,
      weatherLabel: describeWeatherCode(weatherCode),
    };
  });

  return { days };
}
