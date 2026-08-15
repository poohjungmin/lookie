"use client";

import { useMemo } from "react";
import { useApp } from "@/lib/AppContext";
import { useTodayWeather } from "@/lib/useTodayWeather";
import { rankLooksByWeatherSimilarity, findLooksNearThisDate } from "@/lib/weatherSimilarity";
import RecommendedLookCard from "@/components/RecommendedLookCard";

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

export default function HomePage() {
  const { looks, syncing, signOutUser } = useApp();
  const {
    weather: todayWeather,
    loading: weatherLoading,
    errorReason: weatherErrorReason,
    usingCachedLocation,
    retry: retryWeather,
  } = useTodayWeather();

  // 홈 화면이 떠 있는 동안은 "오늘"을 고정한다 - 자정을 넘겨도 화면이 알아서
  // 안 바뀌는 정도는 감수하고, 매 렌더마다 새 Date를 만들어 추천 계산이
  // 다시 도는 것을 막는다.
  const today = useMemo(() => new Date(), []);

  // looks는 이미 local-first로 로드되어 있는 배열 그대로 - 추천 때문에
  // Firestore를 다시 조회하지 않는다. 각 항목이 산술 연산 몇 개뿐이라
  // 룩이 1,000개 이상이어도 이 계산 자체는 무시할 만한 비용이다.
  const similarLooks = useMemo(() => {
    if (!todayWeather) return [];
    return rankLooksByWeatherSimilarity(looks, todayWeather, today, SIMILAR_LOOKS_LIMIT);
  }, [looks, todayWeather, today]);

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

      {/* 현재 날씨 - 위치 권한이 없거나 조회에 실패해도 화면의 나머지
          부분(룩 목록/추천)은 그대로 동작한다. */}
      <section className="rounded-3xl bg-neutral-50 px-6 py-9 text-center">
        <p className="text-xs text-neutral-400">현재 날씨</p>
        {weatherLoading ? (
          <p className="mt-4 text-sm text-neutral-300">날씨 불러오는 중…</p>
        ) : todayWeather ? (
          <div className="mt-3">
            <p className="text-3xl font-semibold text-neutral-900">
              {todayWeather.currentTemp !== null ? `${Math.round(todayWeather.currentTemp)}°` : "-"}
            </p>
            <p className="mt-1.5 text-sm text-neutral-500">
              {todayWeather.weatherLabel}
              {" · 최고 "}
              {todayWeather.tempMax !== null ? `${Math.round(todayWeather.tempMax)}°` : "-"}
              {" · 최저 "}
              {todayWeather.tempMin !== null ? `${Math.round(todayWeather.tempMin)}°` : "-"}
            </p>
            {todayWeather.precipitationProbability !== null && (
              <p className="mt-1 text-xs text-neutral-400">
                강수확률 {Math.round(todayWeather.precipitationProbability)}%
              </p>
            )}
            {usingCachedLocation && (
              <p className="mt-1.5 text-[11px] text-neutral-300">최근 위치 기준</p>
            )}
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-sm text-neutral-300">
              {weatherErrorReason === "denied"
                ? "위치 권한이 없어 날씨를 가져올 수 없어요"
                : "날씨를 가져오지 못했어요"}
            </p>
            <button
              type="button"
              onClick={retryWeather}
              className="mt-2 text-xs text-neutral-400 underline underline-offset-2"
            >
              다시 시도
            </button>
          </div>
        )}
      </section>

      {/* 오늘과 비슷한 날씨에 입었던 룩 - 룩기의 핵심 화면. 새 코디를
          생성하는 게 아니라 실제로 입었던 룩을 다시 보여준다. */}
      {similarLooks.length > 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-neutral-800">
            오늘과 비슷한 날씨에 입었던 룩
          </h2>
          <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
            {similarLooks.map((look) => (
              <RecommendedLookCard key={look.id} look={look} />
            ))}
          </div>
        </section>
      )}

      {todayWeather && hasAnyWeatherTaggedLook && similarLooks.length === 0 && (
        <section className="mt-10">
          <h2 className="text-sm font-medium text-neutral-800">
            오늘과 비슷한 날씨에 입었던 룩
          </h2>
          <p className="mt-3 text-xs text-neutral-300">
            아직 이 날씨와 비슷한 기록이 없어요
          </p>
        </section>
      )}

      {/* 이맘때 입었던 룩 - 데이터가 있을 때만 노출, 위 섹션과 중복되지 않는다. */}
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
