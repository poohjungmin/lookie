"use client";

import { useRef } from "react";
import type { ForecastDay } from "@/lib/currentWeather";
import type { TodayWeatherErrorReason } from "@/lib/useWeeklyForecast";

function parseForecastDate(dateStr: string): Date {
  // "YYYY-MM-DD"를 그대로 new Date()에 넣으면 UTC 자정으로 해석돼 시간대에
  // 따라 하루 밀릴 수 있어, 로컬 자정으로 명시해서 파싱한다.
  return new Date(`${dateStr}T00:00:00`);
}

export function forecastDayLabel(day: ForecastDay, index: number): string {
  if (index === 0) return "오늘";
  if (index === 1) return "내일";
  const date = parseForecastDate(day.date);
  const weekday = date.toLocaleDateString("ko-KR", { weekday: "short" });
  return `${date.getMonth() + 1}월 ${date.getDate()}일 (${weekday})`;
}

/**
 * 홈 상단 날씨 영역. 무거운 carousel 라이브러리 없이 CSS scroll-snap만으로
 * 한 화면에 카드 한 장씩 가로로 스와이프한다 - 섹션 자체가 고정 높이라
 * 가로 스와이프가 페이지 세로 스크롤과 서로 간섭하지 않는다. 스와이프로
 * 카드가 바뀌면 onSelectIndex를 통해 부모(홈 화면)에 알려서, 아래 추천
 * 섹션이 같은 날짜 기준으로 즉시 다시 계산되게 한다 - 이 컴포넌트 자체는
 * Open-Meteo를 다시 부르지 않는다(이미 받아온 days를 그대로 넘겨받는다).
 */
export default function WeeklyForecastCarousel({
  days,
  loading,
  errorReason,
  usingCachedLocation,
  usingSeoulFallback,
  onRetry,
  selectedIndex,
  onSelectIndex,
}: {
  days: ForecastDay[];
  loading: boolean;
  errorReason: TodayWeatherErrorReason | null;
  usingCachedLocation: boolean;
  usingSeoulFallback: boolean;
  onRetry: () => void;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  function handleScroll() {
    const el = scrollerRef.current;
    if (!el || el.clientWidth === 0) return;
    const index = Math.round(el.scrollLeft / el.clientWidth);
    if (index !== selectedIndex) onSelectIndex(index);
  }

  if (loading) {
    return (
      <section className="rounded-3xl bg-neutral-50 px-6 py-9 text-center">
        <p className="text-xs text-neutral-400">날씨</p>
        <p className="mt-4 text-sm text-neutral-300">날씨 불러오는 중…</p>
      </section>
    );
  }

  if (days.length === 0) {
    return (
      <section className="rounded-3xl bg-neutral-50 px-6 py-9 text-center">
        <p className="text-xs text-neutral-400">날씨</p>
        <div className="mt-3">
          <p className="text-sm text-neutral-300">
            {errorReason === "denied"
              ? "위치 권한이 없어 날씨를 가져올 수 없어요"
              : "날씨를 가져오지 못했어요"}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 text-xs text-neutral-400 underline underline-offset-2"
          >
            다시 시도
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-3xl bg-neutral-50">
      <div ref={scrollerRef} onScroll={handleScroll} className="flex snap-x snap-mandatory overflow-x-auto">
        {days.map((day, index) => (
          <div key={day.date} className="w-full shrink-0 snap-center px-6 py-9 text-center">
            <p className="text-xs text-neutral-400">{forecastDayLabel(day, index)}</p>
            <div className="mt-3">
              <p className="text-3xl font-semibold text-neutral-900">
                {day.tempMax !== null ? `${Math.round(day.tempMax)}°` : "-"}
                <span className="text-lg font-normal text-neutral-400">
                  {" / "}
                  {day.tempMin !== null ? `${Math.round(day.tempMin)}°` : "-"}
                </span>
              </p>
              <p className="mt-1.5 text-sm text-neutral-500">{day.weatherLabel}</p>
              {index === 0 && day.currentTemp !== null && (
                <p className="mt-1 text-xs text-neutral-400">지금 {Math.round(day.currentTemp)}°</p>
              )}
              {day.precipitationProbability !== null && day.precipitationProbability > 0 && (
                <p className="mt-1 text-xs text-neutral-400">
                  강수확률 {Math.round(day.precipitationProbability)}%
                </p>
              )}
              {index === 0 && usingSeoulFallback && (
                <p className="mt-1.5 text-[11px] text-neutral-300">서울 기준</p>
              )}
              {index === 0 && !usingSeoulFallback && usingCachedLocation && (
                <p className="mt-1.5 text-[11px] text-neutral-300">최근 위치 기준</p>
              )}
            </div>
          </div>
        ))}
      </div>
      {days.length > 1 && (
        <p className="pb-3 text-center text-[11px] text-neutral-300">
          {selectedIndex + 1} / {days.length}
        </p>
      )}
    </section>
  );
}
