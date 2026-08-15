"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWeeklyForecast, type ForecastDay } from "@/lib/currentWeather";
import { DEFAULT_WEATHER_LOCATION } from "@/lib/weather";

// 마지막으로 성공한 위치를 localStorage에만 저장한다 (Firestore에는 절대
// 저장하지 않는다 - 요구사항). 너무 오래된 위치는 오늘 날씨와 안 맞을 수
// 있어 일정 기간이 지나면 버린다.
const LAST_LOCATION_KEY = "lookie:lastLocation";
const LAST_LOCATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7일
const GEOLOCATION_TIMEOUT_MS = 8000;

type Coords = { lat: number; lon: number };

function readCachedLocation(): Coords | null {
  try {
    const raw = localStorage.getItem(LAST_LOCATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lat: number; lon: number; ts: number };
    if (Date.now() - parsed.ts > LAST_LOCATION_MAX_AGE_MS) return null;
    if (typeof parsed.lat !== "number" || typeof parsed.lon !== "number") return null;
    return { lat: parsed.lat, lon: parsed.lon };
  } catch {
    return null;
  }
}

function writeCachedLocation(coords: Coords) {
  try {
    localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ ...coords, ts: Date.now() }));
  } catch {
    // 무시 - 위치 캐시는 있으면 좋은 정도지 필수는 아니다.
  }
}

function getCurrentPosition(): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("이 브라우저는 위치 조회를 지원하지 않아요"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 5 * 60 * 1000 }
    );
  });
}

export type TodayWeatherErrorReason = "denied" | "unavailable" | "fetch-failed";

export type WeeklyForecastState = {
  /** 오늘 포함 최대 7일, 로딩 전/실패 시에는 빈 배열. */
  days: ForecastDay[];
  loading: boolean;
  errorReason: TodayWeatherErrorReason | null;
  /** 실시간 위치 조회가 실패해서 최근 저장해둔 위치로 대신 조회했는지. */
  usingCachedLocation: boolean;
  /** 위치를 전혀 못 구해(권한 거부 등) 서울을 기본 위치로 썼는지. */
  usingSeoulFallback: boolean;
  retry: () => void;
};

/**
 * 브라우저 Geolocation -> Open-Meteo 주간 예보(오늘 포함 7일)를 한 번만
 * 불러온다. 위치 권한 거부/조회 실패 시 최근 성공했던 위치(로컬 전용)로
 * 폴백하고, 그마저 없으면 과거 날씨 조회와 같은 정책으로 서울을 기본
 * 위치로 써서 예보 자체는 계속 보여준다 - 위치 권한 때문에 홈 화면(날씨
 * 카드 + 추천)이 완전히 막히는 일이 없게 하기 위함이다. 날짜를 넘길 때마다
 * 다시 조회하지 않도록, 7일치를 한 번에 받아 이 상태에 그대로 들고 있는다.
 */
export function useWeeklyForecast(): WeeklyForecastState {
  const [days, setDays] = useState<ForecastDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorReason, setErrorReason] = useState<TodayWeatherErrorReason | null>(null);
  const [usingCachedLocation, setUsingCachedLocation] = useState(false);
  const [usingSeoulFallback, setUsingSeoulFallback] = useState(false);
  // 재시도 도중 새 재시도가 또 들어와도, 먼저 시작된 낡은 요청이 나중에
  // 끝나면서 최신 상태를 덮어쓰지 않도록 순번으로 구분한다.
  const attemptRef = useRef(0);

  const run = useCallback(async () => {
    const myAttempt = ++attemptRef.current;
    setLoading(true);
    setErrorReason(null);

    let coords: Coords;
    let fromCache = false;
    let fromSeoulFallback = false;
    try {
      coords = await getCurrentPosition();
      writeCachedLocation(coords);
    } catch (err) {
      const cached = readCachedLocation();
      if (cached) {
        coords = cached;
        fromCache = true;
      } else {
        // 위치를 전혀 못 구해도 예보 자체는 서울 기준으로 보여준다 - 과거
        // 사진 날씨 조회(weather.ts resolveWeatherLocation)와 같은 정책.
        coords = { lat: DEFAULT_WEATHER_LOCATION.latitude, lon: DEFAULT_WEATHER_LOCATION.longitude };
        fromSeoulFallback = true;
        void err; // 위치 조회 실패 사유 자체는 UI에 노출하지 않는다 (서울로 대체되므로).
      }
    }

    if (attemptRef.current !== myAttempt) return;
    setUsingCachedLocation(fromCache);
    setUsingSeoulFallback(fromSeoulFallback);

    try {
      const result = await fetchWeeklyForecast(coords.lat, coords.lon);
      if (attemptRef.current !== myAttempt) return;
      setDays(result.days);
    } catch {
      if (attemptRef.current !== myAttempt) return;
      setErrorReason("fetch-failed");
    } finally {
      if (attemptRef.current === myAttempt) setLoading(false);
    }
  }, []);

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- 훅이 마운트되면
       곧바로 위치 조회 + 주간 예보 조회를 시작하는 의도적인 데이터 페칭
       (useLocalFirstLooks.ts의 syncNow 호출과 동일한 패턴). */
    run();
  }, [run]);

  return { days, loading, errorReason, usingCachedLocation, usingSeoulFallback, retry: run };
}
