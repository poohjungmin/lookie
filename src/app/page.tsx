"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/lib/AppContext";
import { useWeeklyForecast } from "@/lib/useWeeklyForecast";
import { rankLooksByWeatherSimilarity, findLooksNearThisDate } from "@/lib/weatherSimilarity";
import RecommendedLookCard from "@/components/RecommendedLookCard";
import WeeklyForecastCarousel from "@/components/WeeklyForecastCarousel";
import type { ForecastDay } from "@/lib/currentWeather";

const SIMILAR_LOOKS_LIMIT = 5;
const NEARBY_DATE_LOOKS_LIMIT = 6;
const NEARBY_DATE_WINDOW_DAYS = 7;

function todayKorean(): string {
  return new Date().toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function parseForecastDate(dateStr: string): Date {
  // "YYYY-MM-DD"를 그대로 new Date()에 넣으면 UTC 자정으로 해석돼 시간대에
  // 따라 하루 밀릴 수 있어, 로컬 자정으로 명시해서 파싱한다.
  return new Date(`${dateStr}T00:00:00`);
}

/** 선택된 예보 날짜에 맞춰 추천 섹션 제목을 자연스러운 문구로 바꾼다. */
function recommendationTitle(day: ForecastDay, index: number): string {
  if (index === 0) return "오늘과 비슷한 날씨에 입었던 룩";
  if (index === 1) return "내일 날씨에 입기 좋았던 룩";
  const date = parseForecastDate(day.date);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 날씨와 비슷했던 룩`;
}

export default function HomePage() {
  const { looks, syncing, signOutUser } = useApp();
  const {
    days: forecastDays,
    loading: weatherLoading,
    errorReason: weatherErrorReason,
    usingCachedLocation,
    usingSeoulFallback,
    retry: retryWeather,
  } = useWeeklyForecast();

  // 홈 상단 날씨 카드에서 지금 스와이프되어 화면 중심에 있는 날짜의
  // index(0=오늘). 처음 진입하면 항상 오늘이 기본값이다. 예보 자체는
  // useWeeklyForecast가 이미 한 번에 받아온 배열을 그대로 쓰므로, 날짜를
  // 넘겨도 Open-Meteo를 다시 부르지 않는다.
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);
  const selectedDay = forecastDays[selectedDayIndex] ?? null;

  // 홈 화면이 떠 있는 동안은 "실제 오늘"을 고정한다 - "이맘때 입었던 룩"은
  // 혼란을 줄이기 위해 항상 이 실제 오늘 기준으로 유지하고, 예보 카드를
  // 넘겨도 바뀌지 않는다(날씨 기반 추천만 선택된 날짜를 따라간다).
  const today = useMemo(() => new Date(), []);

  // looks는 이미 local-first로 로드되어 있는 배열 그대로 - 추천 때문에
  // Firestore를 다시 조회하지 않는다. 각 항목이 산술 연산 몇 개뿐이라
  // 룩이 1,000개 이상이어도 이 계산 자체는 무시할 만한 비용이고, 선택된
  // 날짜가 바뀔 때만 다시 계산된다(useMemo).
  const similarLooks = useMemo(() => {
    if (!selectedDay) return [];
    const targetDate = selectedDayIndex === 0 ? today : parseForecastDate(selectedDay.date);
    return rankLooksByWeatherSimilarity(looks, selectedDay, targetDate, SIMILAR_LOOKS_LIMIT);
  }, [looks, selectedDay, selectedDayIndex, today]);

  const nearbyDateLooks = useMemo(() => {
    const excludeIds = new Set(similarLooks.map((l) => l.id));
    return findLooksNearThisDate(looks, today, {
      windowDays: NEARBY_DATE_WINDOW_DAYS,
      excludeIds,
      limit: NEARBY_DATE_LOOKS_LIMIT,
    });
  }, [looks, today, similarLooks]);

  const hasAnyWeatherTaggedLook = useMemo(
    () => looks.some((l) => l.weatherStatus === "success" && l.weather && l.takenAt),
    [looks]
  );

  return (
    <div className="mx-auto max-w-2xl px-5 pb-10 pt-10 sm:px-6">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-neutral-400">
            LOOKIE
          </p>
          <h1 className="mt-1 text-xl font-semibold text-neutral-900">
            {todayKorean()}
          </h1>
        </div>
        <button
          type="button"
          onClick={signOutUser}
          className="mt-1 text-xs text-neutral-300 underline underline-offset-2"
        >
          로그아웃
        </button>
      </header>

      {/* 이번 주 날씨 - 위치 권한이 없거나 조회에 실패해도 화면의 나머지
          부분(룩 목록/추천)은 그대로 동작한다. 좌우로 넘기면 아래 추천이
          같이 바뀐다. */}
      <WeeklyForecastCarousel
        days={forecastDays}
        loading={weatherLoading}
        errorReason={weatherErrorReason}
        usingCachedLocation={usingCachedLocation}
        usingSeoulFallback={usingSeoulFallback}
        onRetry={retryWeather}
        selectedIndex={selectedDayIndex}
        onSelectIndex={setSelectedDayIndex}
      />

      {/* 날씨 기반 추천 - 룩기의 핵심 화면. 새 코디를 생성하는 게 아니라
          실제로 입었던 룩을 다시 보여준다. 제목/후보 모두 위에서 선택된
          예보 날짜를 따라간다. */}
      {selectedDay && similarLooks.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-neutral-800">
            {recommendationTitle(selectedDay, selectedDayIndex)}
          </h2>
          <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
            {similarLooks.map((look) => (
              <RecommendedLookCard key={look.id} look={look} />
            ))}
          </div>
        </section>
      )}

      {selectedDay && hasAnyWeatherTaggedLook && similarLooks.length === 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-neutral-800">
            {recommendationTitle(selectedDay, selectedDayIndex)}
          </h2>
          <p className="mt-3 text-xs text-neutral-300">
            아직 이 날씨와 비슷한 기록이 없어요
          </p>
        </section>
      )}

      {/* 이맘때 입었던 룩 - 데이터가 있을 때만 노출, 위 섹션과 중복되지
          않는다. 예보 카드를 넘겨도 바뀌지 않고 항상 실제 오늘 기준이다. */}
      {nearbyDateLooks.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-neutral-800">
            이맘때 입었던 룩
          </h2>
          <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
            {nearbyDateLooks.map((look) => (
              <RecommendedLookCard key={look.id} look={look} />
            ))}
          </div>
        </section>
      )}

      {syncing && looks.length === 0 && (
        <p className="mt-10 text-center text-xs text-neutral-400">
          불러오는 중…
        </p>
      )}

      {!syncing && looks.length === 0 && (
        <p className="mt-10 text-center text-xs text-neutral-300">
          아직 저장된 룩이 없어요. + 버튼으로 첫 룩을 추가해보세요.
        </p>
      )}
    </div>
  );
}
