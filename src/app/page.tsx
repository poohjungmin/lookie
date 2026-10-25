"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/lib/AppContext";
import { useWeeklyForecast } from "@/lib/useWeeklyForecast";
import { searchLooksByTemperature } from "@/lib/weatherSimilarity";
import RecommendedLookCard from "@/components/RecommendedLookCard";
import WeeklyForecastCarousel from "@/components/WeeklyForecastCarousel";
import type { ForecastDay } from "@/lib/currentWeather";
import {
  useDressLevels,
  filterLooksByDressLevel,
  type DressLevelFilter,
} from "@/lib/dressLevel";

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
  if (index === 1) return "내일과 비슷한 날씨에 입었던 룩";
  const date = parseForecastDate(day.date);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 날씨와 비슷했던 룩`;
}

export default function HomePage() {
  const { DRESS_LEVEL_FILTERS, dressLevelFilterLabel } = useDressLevels();
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

  // 카테고리를 유지하면서 선택한 예보의 기온에 맞는 기록을 모두 찾는다.
  const [dressFilter, setDressFilter] = useState<DressLevelFilter>("all");
  const similarLooks = useMemo(() => {
    if (!selectedDay || selectedDay.tempMax === null || selectedDay.tempMin === null) return [];
    const candidates = filterLooksByDressLevel(looks, dressFilter);
    return searchLooksByTemperature(candidates, {
      targetMax: selectedDay.tempMax,
      targetMin: selectedDay.tempMin,
      rain: "any",
    }, { expandRange: false, limit: Infinity });
  }, [looks, selectedDay, dressFilter]);

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

      {selectedDay && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-neutral-800">
            {recommendationTitle(selectedDay, selectedDayIndex)}
          </h2>
          {/* 추천 룩 이미지가 먼저 눈에 들어와야 하므로 필터 존재감은
              최소화한다 - 기온으로 찾기 패널의 칩보다도 한 단계 더 가볍게
              (높이/패딩 축소, 미선택 테두리를 더 연하게). */}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {DRESS_LEVEL_FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setDressFilter(f)}
                className={
                  "rounded-full border px-2.5 py-1 text-[11px] font-medium " +
                  (dressFilter === f
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-neutral-200 text-neutral-500")
                }
              >
                {dressLevelFilterLabel(f)}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-400">최고·최저기온 각각 ±5℃ 이내 · {similarLooks.length}개</p>
          {similarLooks.length > 0 ? (
            <div className="mt-4 grid grid-cols-3 gap-x-2 gap-y-5">
              {similarLooks.map((look) => (
                <RecommendedLookCard key={look.id} look={look} />
              ))}
            </div>
          ) : (
            <p className="mt-4 text-xs text-neutral-300">
              {dressFilter === "all" ? "아직 이 날씨와 비슷한 기록이 없어요" : "조건에 맞는 룩이 없어요."}
            </p>
          )}
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
