// Open-Meteo Historical Weather API 연동.
// - 무료, API Key 불필요 (비상업적 사용 기준 요청 제한만 있음)
// - https://open-meteo.com/en/docs/historical-weather-api

export type WeatherResult = {
  maxTemp: number | null;
  minTemp: number | null;
  meanTemp: number | null;
  precipitationSum: number | null;
  maxWindSpeed: number | null;
  weatherCode: number | null;
  weatherLabel: string;
};

// WMO Weather interpretation codes (Open-Meteo가 그대로 사용)
const WEATHER_CODE_LABELS: Record<number, string> = {
  0: "맑음",
  1: "대체로 맑음",
  2: "구름 조금",
  3: "흐림",
  45: "안개",
  48: "서리 안개",
  51: "약한 이슬비",
  53: "이슬비",
  55: "강한 이슬비",
  56: "약한 언 이슬비",
  57: "언 이슬비",
  61: "약한 비",
  63: "비",
  65: "강한 비",
  66: "약한 언 비",
  67: "언 비",
  71: "약한 눈",
  73: "눈",
  75: "강한 눈",
  77: "싸락눈",
  80: "약한 소나기",
  81: "소나기",
  82: "강한 소나기",
  85: "약한 눈 소나기",
  86: "강한 눈 소나기",
  95: "뇌우",
  96: "우박 동반 뇌우",
  99: "강한 우박 동반 뇌우",
};

export function describeWeatherCode(code: number | null): string {
  if (code === null || code === undefined) return "정보 없음";
  return WEATHER_CODE_LABELS[code] ?? `날씨 코드 ${code}`;
}

/**
 * WMO weather code를 의미 있는 그룹으로 묶는다. 오늘/과거 날씨의 "날씨
 * 상태" 유사도는 코드를 그대로 숫자로 비교하지 않고 이 그룹으로 비교한다
 * (예: 61번 "약한 비"와 65번 "강한 비"는 코드값은 멀지만 그룹은 같다).
 */
export type WeatherGroup = "clear" | "cloudy" | "rain" | "snow" | "other";

export function weatherGroupOf(code: number | null): WeatherGroup {
  if (code === null || code === undefined) return "other";
  if (code === 0 || code === 1) return "clear";
  if (code === 2 || code === 3 || code === 45 || code === 48) return "cloudy";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code === 95 || code === 96 || code === 99) {
    return "rain";
  }
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  return "other";
}

function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 같은 날짜 + 비슷한 위치(약 1.1km 이내, 소수점 둘째 자리 반올림)의 사진은
// 동일한 캐시 키를 공유해 API를 중복 호출하지 않는다.
// Promise 자체를 캐싱하므로, 아직 응답이 오지 않은 동시 요청끼리도 하나의
// 네트워크 호출만 실제로 발생한다.
const weatherCache = new Map<string, Promise<WeatherResult>>();

function cacheKey(lat: number, lon: number, dateStr: string): string {
  return `${dateStr}_${lat.toFixed(2)}_${lon.toFixed(2)}`;
}

export async function fetchHistoricalWeather(
  latitude: number,
  longitude: number,
  date: Date
): Promise<WeatherResult> {
  const dateStr = toDateString(date);
  const key = cacheKey(latitude, longitude, dateStr);

  const cached = weatherCache.get(key);
  if (cached) return cached;

  const promise = (async (): Promise<WeatherResult> => {
    const url = new URL("https://archive-api.open-meteo.com/v1/archive");
    url.searchParams.set("latitude", latitude.toFixed(4));
    url.searchParams.set("longitude", longitude.toFixed(4));
    url.searchParams.set("start_date", dateStr);
    url.searchParams.set("end_date", dateStr);
    url.searchParams.set(
      "daily",
      [
        "weathercode",
        "temperature_2m_max",
        "temperature_2m_min",
        "temperature_2m_mean",
        "precipitation_sum",
        "windspeed_10m_max",
      ].join(",")
    );
    url.searchParams.set("timezone", "auto");

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Open-Meteo 응답 오류 (HTTP ${res.status})`);
    }

    const json = await res.json();
    const daily = json?.daily;
    if (!daily || !Array.isArray(daily.time) || daily.time.length === 0) {
      throw new Error("해당 날짜의 날씨 데이터를 찾을 수 없음");
    }

    const weatherCode: number | null = daily.weathercode?.[0] ?? null;

    return {
      maxTemp: daily.temperature_2m_max?.[0] ?? null,
      minTemp: daily.temperature_2m_min?.[0] ?? null,
      meanTemp: daily.temperature_2m_mean?.[0] ?? null,
      precipitationSum: daily.precipitation_sum?.[0] ?? null,
      maxWindSpeed: daily.windspeed_10m_max?.[0] ?? null,
      weatherCode,
      weatherLabel: describeWeatherCode(weatherCode),
    };
  })();

  weatherCache.set(key, promise);
  // 실패한 요청은 캐시에서 제거해, 일시적 네트워크 문제로 다음 사진까지
  // 영구히 실패로 남지 않도록 한다 (다음 호출에서 재시도 가능).
  promise.catch(() => weatherCache.delete(key));

  return promise;
}
