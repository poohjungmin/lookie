"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";
import LookThumbImage from "@/components/LookThumbImage";
import {
  isWeatherMissing,
  recoverMissingWeather,
  type BulkWeatherRecoveryProgress,
  type BulkWeatherRecoveryResult,
} from "@/lib/bulkWeatherRecovery";
import { searchLooksByTemperature, type TemperatureRainFilter } from "@/lib/weatherSimilarity";
import {
  DRESS_LEVEL_FILTERS,
  dressLevelFilterLabel,
  filterLooksByDressLevel,
  parseDressLevelFilter,
  type DressLevelFilter,
} from "@/lib/dressLevel";

const RAIN_OPTIONS: { value: TemperatureRainFilter; label: string }[] = [
  { value: "any", label: "상관없음" },
  { value: "no-rain", label: "비 안 옴" },
  { value: "rain", label: "비 옴" },
];

function LooksPageInner() {
  const { user, looks, syncing, patchLookWeather } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const missingWeatherLooks = useMemo(() => looks.filter(isWeatherMissing), [looks]);

  const [recovering, setRecovering] = useState(false);
  const [progress, setProgress] = useState<BulkWeatherRecoveryProgress | null>(null);
  const [result, setResult] = useState<BulkWeatherRecoveryResult | null>(null);

  async function handleBulkRecoverWeather() {
    if (recovering || missingWeatherLooks.length === 0) return;
    setRecovering(true);
    setResult(null);
    setProgress({ done: 0, total: missingWeatherLooks.length });
    try {
      const res = await recoverMissingWeather(user.uid, missingWeatherLooks, {
        onProgress: setProgress,
        // 이미지가 전혀 바뀌지 않았으니, 룩 하나가 성공할 때마다 캐시된
        // 썸네일/누끼를 무효화하는 refreshSingleLook 대신 weather 필드만
        // 가볍게 갱신한다 - 전체 룩/캘린더/상세/홈 추천이 완료를 기다리지
        // 않고 룩이 하나씩 복구되는 대로 즉시 반영된다.
        onLookRecovered: (lookId, weather, weatherStatus) => {
          patchLookWeather(lookId, weather, weatherStatus);
        },
      });
      setResult(res);
    } finally {
      setRecovering(false);
    }
  }

  // --- 기온으로 찾기 -----------------------------------------------------
  // 검색 조건(mode/max/min/rain)은 URL 쿼리에 실어서 상세 화면에서 뒤로가기
  // 했을 때, 새로고침했을 때, PWA를 다시 열었을 때 모두 그대로 복원되게
  // 한다 - 로컬 state만 썼다면 상세로 갔다 오는 순간 사라졌을 것이다.
  const isWeatherSearchMode = searchParams.get("mode") === "weather";
  const [searchOpen, setSearchOpen] = useState(isWeatherSearchMode);
  const [maxInput, setMaxInput] = useState(searchParams.get("max") ?? "");
  const [minInput, setMinInput] = useState(searchParams.get("min") ?? "");
  const [rain, setRain] = useState<TemperatureRainFilter>(
    (searchParams.get("rain") as TemperatureRainFilter | null) ?? "any"
  );
  const [dressFilter, setDressFilter] = useState<DressLevelFilter>(
    parseDressLevelFilter(searchParams.get("dress"))
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  // "전체 룩" 옆 "···" 보조 메뉴 - 지금은 "꾸밈레벨 정하기" 항목 하나뿐이다.
  // 바깥을 누르면 닫힌다. 페이지를 벗어나면(다른 라우트로 이동) 이 state
  // 자체가 언마운트되며 사라지므로 별도로 남는 메뉴 상태는 없다.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("touchstart", handleOutside);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("touchstart", handleOutside);
    };
  }, [menuOpen]);

  const activeQuery = useMemo(() => {
    if (!isWeatherSearchMode) return null;
    const max = Number(searchParams.get("max"));
    const min = Number(searchParams.get("min"));
    if (!Number.isFinite(max) || !Number.isFinite(min)) return null;
    const rainParam = (searchParams.get("rain") as TemperatureRainFilter | null) ?? "any";
    const dressParam = parseDressLevelFilter(searchParams.get("dress"));
    return { targetMax: max, targetMin: min, rain: rainParam, dressLevel: dressParam };
  }, [isWeatherSearchMode, searchParams]);

  // looks는 이미 local-first로 로드된 배열 그대로 - 검색 때문에 Firestore를
  // 다시 조회하지 않는다. 꾸밈레벨은 기온 similarity 계산 "전"에 후보를
  // 거르는 사전 필터일 뿐, searchLooksByTemperature 내부 로직/점수는 전혀
  // 바꾸지 않는다: 전체 룩 -> 꾸밈레벨로 후보 필터 -> 기존 기온 similarity.
  const searchResults = useMemo(() => {
    if (!activeQuery) return [];
    const candidates = filterLooksByDressLevel(looks, activeQuery.dressLevel);
    return searchLooksByTemperature(candidates, activeQuery);
  }, [looks, activeQuery]);

  function handleSearch() {
    const maxNum = Number(maxInput);
    const minNum = Number(minInput);
    if (maxInput.trim() === "" || minInput.trim() === "" || !Number.isFinite(maxNum) || !Number.isFinite(minNum)) {
      setValidationError("최고기온과 최저기온을 입력해주세요.");
      return;
    }
    if (maxNum <= minNum) {
      setValidationError("최고기온은 최저기온보다 높게 입력해 주세요.");
      return;
    }
    setValidationError(null);
    router.push(
      `${pathname}?mode=weather&max=${encodeURIComponent(maxInput)}&min=${encodeURIComponent(minInput)}&rain=${rain}&dress=${dressFilter}`
    );
  }

  function closeSearch() {
    setSearchOpen(false);
    setValidationError(null);
    if (isWeatherSearchMode) router.push(pathname);
  }

  const searchLinkQuery = activeQuery
    ? `from=looks&mode=weather&max=${encodeURIComponent(String(activeQuery.targetMax))}&min=${encodeURIComponent(
        String(activeQuery.targetMin)
      )}&rain=${activeQuery.rain}&dress=${activeQuery.dressLevel}`
    : "";

  return (
    <div className="mx-auto max-w-2xl px-3 pb-10 pt-10 sm:px-5">
      <header className="mb-6 flex items-start justify-between px-2">
        <div>
          <p className="text-xs font-medium tracking-wide text-neutral-400">
            LOOKIE
          </p>
          <div className="mt-1 flex items-center gap-0.5">
            <h1 className="text-xl font-semibold text-neutral-900">
              전체 룩
            </h1>
            {/* 보조 액션(꾸밈레벨 정하기)을 제목 옆의 작은 "···"로 옮겨,
                오른쪽의 기온 검색 진입점과 시각적 무게를 다르게 준다. */}
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-label="더보기"
                aria-expanded={menuOpen}
                className="flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none text-neutral-400 active:bg-neutral-100"
              >
                ···
              </button>
              {menuOpen && (
                <div className="absolute left-0 top-full z-20 mt-1 w-40 rounded-xl border border-neutral-200 bg-white py-1 shadow-sm">
                  <Link
                    href="/looks/dress-level"
                    onClick={() => setMenuOpen(false)}
                    className="block px-3 py-2.5 text-sm text-neutral-700 active:bg-neutral-50"
                  >
                    꾸밈레벨 정하기
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setSearchOpen((v) => !v)}
          className="mt-1 shrink-0 rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700"
        >
          {searchOpen ? "닫기" : "🌡️ 기온으로 찾기"}
        </button>
      </header>

      {/* 기온 검색 패널 - 상단에서 펼쳐지는 방식. 숫자 키패드가 뜨도록
          inputMode="decimal"을 쓰고, 소수점도 허용한다. */}
      {searchOpen && (
        <section className="mb-6 rounded-2xl border border-neutral-100 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-neutral-500">최고기온</span>
              <div className="mt-1 flex items-center rounded-lg border border-neutral-300 px-3 py-2">
                <input
                  type="text"
                  inputMode="decimal"
                  value={maxInput}
                  onChange={(e) => setMaxInput(e.target.value)}
                  placeholder="28"
                  className="w-full text-sm text-neutral-900 outline-none"
                />
                <span className="text-sm text-neutral-400">°C</span>
              </div>
            </label>
            <label className="block">
              <span className="text-xs text-neutral-500">최저기온</span>
              <div className="mt-1 flex items-center rounded-lg border border-neutral-300 px-3 py-2">
                <input
                  type="text"
                  inputMode="decimal"
                  value={minInput}
                  onChange={(e) => setMinInput(e.target.value)}
                  placeholder="21"
                  className="w-full text-sm text-neutral-900 outline-none"
                />
                <span className="text-sm text-neutral-400">°C</span>
              </div>
            </label>
          </div>

          <div className="mt-3">
            <span className="text-xs text-neutral-500">비</span>
            <div className="mt-1.5 flex gap-2">
              {RAIN_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRain(opt.value)}
                  className={
                    "rounded-full border px-3 py-1.5 text-xs font-medium " +
                    (rain === opt.value
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-300 text-neutral-600")
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* 꾸밈레벨 - similarity 점수에 관여하지 않는 사전 필터. 미분류
              룩은 "전체"일 때만 후보에 포함된다(filterLooksByDressLevel). */}
          <div className="mt-3">
            <span className="text-xs text-neutral-500">꾸밈레벨</span>
            <div className="mt-1.5 flex gap-2">
              {DRESS_LEVEL_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setDressFilter(f)}
                  className={
                    "rounded-full border px-3 py-1.5 text-xs font-medium " +
                    (dressFilter === f
                      ? "border-neutral-900 bg-neutral-900 text-white"
                      : "border-neutral-300 text-neutral-600")
                  }
                >
                  {dressLevelFilterLabel(f)}
                </button>
              ))}
            </div>
          </div>

          {validationError && <p className="mt-3 text-xs text-red-600">{validationError}</p>}

          <button
            type="button"
            onClick={handleSearch}
            className="mt-4 w-full rounded-xl bg-neutral-900 py-2.5 text-center text-sm font-medium text-white"
          >
            비슷한 룩 찾기
          </button>
        </section>
      )}

      {activeQuery ? (
        <section>
          <div className="flex items-center justify-between px-2">
            <h2 className="text-sm font-medium text-neutral-800">
              최고 {activeQuery.targetMax}° / 최저 {activeQuery.targetMin}°와 비슷했던 룩
            </h2>
            <button
              type="button"
              onClick={closeSearch}
              className="shrink-0 text-xs text-neutral-400 underline underline-offset-2"
            >
              검색 닫기
            </button>
          </div>

          {searchResults.length === 0 ? (
            <p className="mt-6 text-center text-xs text-neutral-300">조건에 맞는 룩이 없어요.</p>
          ) : (
            <div className="mt-4 grid grid-cols-3 gap-x-2 gap-y-5">
              {searchResults.map((look) => (
                <Link key={look.id} href={`/looks/${look.id}?${searchLinkQuery}`} className="block">
                  <div className="aspect-[3/4] overflow-hidden rounded-xl bg-neutral-50">
                    <LookThumbImage look={look} className="h-full w-full object-contain" />
                  </div>
                  <p className="mt-1.5 text-center text-[10px] text-neutral-400">
                    {look.takenAt ? formatDateOnly(look.takenAt.toDate()) : ""}
                  </p>
                  <p className="text-center text-[11px] font-medium text-neutral-700">
                    {look.weather?.tempMax !== null && look.weather?.tempMax !== undefined
                      ? `${Math.round(look.weather.tempMax)}°`
                      : "-"}
                    {" / "}
                    {look.weather?.tempMin !== null && look.weather?.tempMin !== undefined
                      ? `${Math.round(look.weather.tempMin)}°`
                      : "-"}
                  </p>
                  {look.weather?.weatherLabel && (
                    <p className="text-center text-[10px] text-neutral-400">{look.weather.weatherLabel}</p>
                  )}
                </Link>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          {/* 날씨 정보가 없는 룩이 하나라도 있을 때만 보여준다 - 전부 정상이면
              아무것도 표시하지 않아 화면이 복잡해지지 않는다. */}
          {missingWeatherLooks.length > 0 && (
            <section className="mb-6 rounded-2xl border border-neutral-100 px-4 py-3.5">
              {!recovering && !result && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-neutral-600">
                    날씨 정보 없는 룩 {missingWeatherLooks.length}개
                  </p>
                  <button
                    type="button"
                    onClick={handleBulkRecoverWeather}
                    className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700"
                  >
                    날씨 일괄 재조회
                  </button>
                </div>
              )}
              {recovering && (
                <p className="text-sm text-neutral-500">
                  {!progress || progress.done === 0
                    ? "날씨 정보 확인 중…"
                    : `${progress.done} / ${progress.total} 복구 중`}
                </p>
              )}
              {result && !recovering && (
                <p className="text-sm text-neutral-600">
                  {result.failed === 0 && result.skippedNoDate === 0
                    ? `${result.succeeded}개 날씨 정보 복구 완료`
                    : `날씨 복구 완료 · 성공 ${result.succeeded}개 · 실패 ${result.failed}개 · 날짜 없음 ${result.skippedNoDate}개`}
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
              아직 저장된 룩이 없습니다
            </p>
          )}

          {/* 사진 갤러리보다 옷장/아카이브에 가깝게 보이도록 한 줄에 3개를 촘촘히
              배치한다. 카드 비율(3:4=0.75)이 누끼 이미지 비율(약 2:3=0.667)보다
              가로로 조금 더 넓기 때문에, object-contain이 세로 기준으로 꽉 차게
              맞춰줘서 별도 확대 없이도 머리~발이 카드 높이의 대부분(정규화
              단계에서 이미 95%로 맞춰짐, src/lib/cutout.ts BODY_HEIGHT_RATIO)을
              차지하면서 잘리지 않는다. 배경은 흰색/연한 회색으로 통일. */}
          <div className="grid grid-cols-3 gap-x-2 gap-y-5">
            {looks.map((look) => (
              <Link key={look.id} href={`/looks/${look.id}?from=looks`} className="block">
                <div className="aspect-[3/4] overflow-hidden rounded-xl bg-neutral-50">
                  <LookThumbImage look={look} className="h-full w-full object-contain" />
                </div>
                {look.takenAt && (
                  <p className="mt-1.5 text-center text-[10px] text-neutral-400">
                    {formatDateOnly(look.takenAt.toDate())}
                  </p>
                )}
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function LooksPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-2xl px-3 pt-10 text-center sm:px-5">
          <p className="text-sm text-neutral-400">불러오는 중…</p>
        </div>
      }
    >
      <LooksPageInner />
    </Suspense>
  );
}
