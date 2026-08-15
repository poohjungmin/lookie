// "오늘과 비슷한 날씨에 입었던 룩" / "이맘때 입었던 룩" 계산.
// 전부 브라우저에서 순수 산술로 계산한다 - AI/API 추가 호출 없음, 풍속은
// 어디에서도 쓰지 않는다. looks는 이미 local-first로 로드되어 있는
// 배열을 그대로 받으므로 Firestore를 다시 조회하지 않는다.

import type { DbWeather } from "@/lib/lookStore";
import type { TodayWeather } from "@/lib/currentWeather";
import { weatherGroupOf } from "@/lib/weather";
import type { DisplayLook } from "@/lib/useLocalFirstLooks";

// 가중치 - 합이 1이 되도록 맞췄고, 나중에 조절하기 쉽도록 상수로 뺐다.
export const TEMP_MEAN_WEIGHT = 0.35;
export const TEMP_MAX_WEIGHT = 0.2;
export const TEMP_MIN_WEIGHT = 0.2;
export const RAIN_WEIGHT = 0.15;
export const WEATHER_CODE_WEIGHT = 0.05;
export const SEASON_WEIGHT = 0.05;

// 기온 차이 -> 유사도 감쇠 폭(가우시안 sigma, ℃). 클수록 온도 차이에 관대해진다.
// sigma=4일 때 diff 1℃→0.97(매우 유사), 2.5℃→0.82(유사), 4.5℃→0.53(조금 유사),
// 6℃→0.33, 8℃→0.14(낮음)로 감소한다 - "하드코딩된 구간"이 아니라 연속적인
// 감쇠 곡선이면서, 요구사항이 예시로 든 구간별 체감과도 자연스럽게 맞아떨어진다.
const TEMP_SIGMA_C = 4;

// 계절/날짜 근접도 감쇠 폭(일). 날씨 자체가 비슷하면 계절이 달라도 추천될
// 수 있어야 하므로, 감쇠를 완만하게 잡는 대신 가중치(SEASON_WEIGHT) 자체를
// 낮게 유지해 전체 점수에 대한 영향을 작게 제한한다.
const SEASON_SIGMA_DAYS = 25;

// "이맘때 입었던 룩" 섹션의 날짜 근접 창(일).
const NEARBY_DATE_WINDOW_DAYS = 7;

function gaussianScore(diff: number, sigma: number): number {
  return Math.exp(-(diff * diff) / (2 * sigma * sigma));
}

function tempDiffScore(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return gaussianScore(Math.abs(a - b), TEMP_SIGMA_C);
}

function isRainyWeather(precipitation: number | null, code: number | null): boolean {
  const group = weatherGroupOf(code);
  return (precipitation !== null && precipitation > 0.1) || group === "rain" || group === "snow";
}

/** 두 날짜 사이의 "일" 단위 순환 거리 - 연도는 무시하고 월/일만 비교한다 (최대 ~182.5일). */
export function dateProximityDays(a: Date, b: Date): number {
  const dayOfYear = (d: Date) => {
    const start = new Date(d.getFullYear(), 0, 1);
    return Math.floor((d.getTime() - start.getTime()) / 86400000);
  };
  const diff = Math.abs(dayOfYear(a) - dayOfYear(b));
  return Math.min(diff, 365 - diff);
}

/**
 * 오늘 날씨 vs 과거 룩 하나의 유사도(0~1, 높을수록 유사)를 계산한다.
 * 풍속은 절대 쓰지 않는다. 구성요소 중 데이터가 없는 항목은 그 항목만
 * 빼고 나머지 가중치로 재정규화한다 - tempMax가 없는 옛날 룩도 나머지
 * 요소만으로 합리적인 점수를 받는다. 내부 랭킹 전용 - 사용자에게는
 * 숫자를 노출하지 않는다.
 */
export function computeWeatherSimilarity(
  today: TodayWeather,
  todayDate: Date,
  lookWeather: DbWeather,
  lookDate: Date
): number {
  const components: Array<[number, number | null]> = [
    [TEMP_MEAN_WEIGHT, tempDiffScore(today.tempMean, lookWeather.tempMean)],
    [TEMP_MAX_WEIGHT, tempDiffScore(today.tempMax, lookWeather.tempMax)],
    [TEMP_MIN_WEIGHT, tempDiffScore(today.tempMin, lookWeather.tempMin)],
    [
      RAIN_WEIGHT,
      isRainyWeather(today.precipitationSum, today.weatherCode) ===
      isRainyWeather(lookWeather.precipitation, lookWeather.weatherCode)
        ? 1
        : 0,
    ],
    [
      WEATHER_CODE_WEIGHT,
      weatherGroupOf(today.weatherCode) === weatherGroupOf(lookWeather.weatherCode) ? 1 : 0,
    ],
    [SEASON_WEIGHT, gaussianScore(dateProximityDays(todayDate, lookDate), SEASON_SIGMA_DAYS)],
  ];

  let weightedSum = 0;
  let weightTotal = 0;
  for (const [weight, value] of components) {
    if (value === null) continue;
    weightedSum += weight * value;
    weightTotal += weight;
  }
  if (weightTotal === 0) return 0;
  return weightedSum / weightTotal;
}

/** weather 데이터가 실제로 유사도 계산에 쓸 수 있는 상태인지. */
function hasUsableWeather(
  look: DisplayLook
): look is DisplayLook & { weather: DbWeather; takenAt: NonNullable<DisplayLook["takenAt"]> } {
  return look.weatherStatus === "success" && !!look.weather && !!look.takenAt;
}

/**
 * 오늘과 날씨가 비슷했던 과거 룩 상위 N개. weather 데이터가 없는 룩은
 * 애초에 계산 대상에서 제외한다. looks가 1,000개 이상이어도 각 항목이
 * 몇 번의 산술 연산뿐이라 O(n) 스캔 + 정렬로 충분히 가볍다.
 */
export function rankLooksByWeatherSimilarity(
  looks: DisplayLook[],
  today: TodayWeather,
  todayDate: Date,
  limit: number
): DisplayLook[] {
  const scored: Array<{ look: DisplayLook; score: number }> = [];
  for (const look of looks) {
    if (!hasUsableWeather(look)) continue;
    const score = computeWeatherSimilarity(today, todayDate, look.weather, look.takenAt.toDate());
    scored.push({ look, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.look);
}

/**
 * "이맘때 입었던 룩" - 오늘의 월/일 기준 ±windowDays 이내의 과거 연도
 * 기록만 후보로 쓴다 (올해 것은 이미 "최근"이라 이 섹션의 의도와 다르고,
 * "오늘과 비슷한 날씨" 섹션과도 자연스럽게 구분된다). excludeIds로 이미
 * 위 섹션에 나온 룩은 중복 노출하지 않는다.
 */
export function findLooksNearThisDate(
  looks: DisplayLook[],
  todayDate: Date,
  options: { windowDays?: number; excludeIds?: Set<string>; limit?: number } = {}
): DisplayLook[] {
  const windowDays = options.windowDays ?? NEARBY_DATE_WINDOW_DAYS;
  const limit = options.limit ?? 6;
  const excludeIds = options.excludeIds ?? new Set<string>();
  const currentYear = todayDate.getFullYear();

  const candidates: Array<{ look: DisplayLook; distance: number; takenAtMs: number }> = [];
  for (const look of looks) {
    if (!look.takenAt || excludeIds.has(look.id)) continue;
    const takenDate = look.takenAt.toDate();
    if (takenDate.getFullYear() === currentYear) continue;
    const distance = dateProximityDays(todayDate, takenDate);
    if (distance <= windowDays) {
      candidates.push({ look, distance, takenAtMs: look.takenAt.toMillis() });
    }
  }

  candidates.sort((a, b) => (a.distance !== b.distance ? a.distance - b.distance : b.takenAtMs - a.takenAtMs));
  return candidates.slice(0, limit).map((c) => c.look);
}
