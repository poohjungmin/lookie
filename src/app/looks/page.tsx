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
import {
  filterLooksByRain,
  searchLooksByTemperature,
  sortLooksByTakenAtDesc,
  type TemperatureRainFilter,
} from "@/lib/weatherSimilarity";
import {
  DRESS_LEVEL_FILTERS,
  dressLevelFilterLabel,
  filterLooksByDressLevel,
  parseDressLevelFilter,
  type DressLevelFilter,
} from "@/lib/dressLevel";

const RAIN_OPTIONS: { value: TemperatureRainFilter; label: string }[] = [
  { value: "any", label: "전체" },
  { value: "no-rain", label: "비 안 옴" },
  { value: "rain", label: "비 옴" },
];

/** 검색 결과 상단 제목 - 실제로 적용된 조건만 자연스럽게 이어붙인다. */
function searchResultTitle(query: {
  targetMax: number | null;
  targetMin: number | null;
  rain: TemperatureRainFilter;
  dressLevel: DressLevelFilter;
}): string {
  const extra: string[] = [];
  if (query.rain !== "any") extra.push(query.rain === "rain" ? "비 온 날" : "비 안 온 날");
  if (query.dressLevel !== "all") extra.push(dressLevelFilterLabel(query.dressLevel));

  const hasTemp = query.targetMax !== null && query.targetMin !== null;
  if (hasTemp) {
    const base = `최고 ${query.targetMax}° / 최저 ${query.targetMin}°와 비슷했던 룩`;
    return extra.length > 0 ? `${base} · ${extra.join(" · ")}` : base;
  }
  return extra.length > 0 ? `${extra.join(" · ")} 룩` : "검색 결과";
}

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

  // 기온은 이제 필수가 아니다 - max/min이 URL에 둘 다 있을 때만 기온 조건이
  // "있는" 것으로 본다(하나만 있는 URL은 애초에 handleSearch가 만들지
  // 않지만, 방어적으로 여기서도 둘 다 있을 때만 인정한다).
  const activeQuery = useMemo(() => {
    if (!isWeatherSearchMode) return null;
    const maxRaw = searchParams.get("max");
    const minRaw = searchParams.get("min");
    const max = maxRaw !== null ? Number(maxRaw) : null;
    const min = minRaw !== null ? Number(minRaw) : null;
    const hasTemp = max !== null && min !== null && Number.isFinite(max) && Number.isFinite(min);
    const rainParam = (searchParams.get("rain") as TemperatureRainFilter | null) ?? "any";
    const dressParam = parseDressLevelFilter(searchParams.get("dress"));
    return {
      targetMax: hasTemp ? max : null,
      targetMin: hasTemp ? min : null,
      rain: rainParam,
      dressLevel: dressParam,
    };
  }, [isWeatherSearchMode, searchParams]);

  // looks는 이미 local-first로 로드된 배열 그대로 - 검색 때문에 Firestore를
  // 다시 조회하지 않는다. 비/꾸밈레벨은 기온 similarity 계산 "전"에 후보를
  // 거르는 사전 필터일 뿐 점수에 관여하지 않는다 - searchLooksByTemperature
  // 자체는 손대지 않고, 기온 조건이 있을 때만 호출한다: 전체 룩 -> 비 필터
  // -> 꾸밈레벨 필터 -> (기온 있으면) 기존 기온 similarity, (없으면) 촬영일 최신순.
  const searchResults = useMemo(() => {
    if (!activeQuery) return [];
    const rainFiltered = filterLooksByRain(looks, activeQuery.rain);
    const candidates = filterLooksByDressLevel(rainFiltered, activeQuery.dressLevel);
    if (activeQuery.targetMax !== null && activeQuery.targetMin !== null) {
      return searchLooksByTemperature(candidates, {
        targetMax: activeQuery.targetMax,
        targetMin: activeQuery.targetMin,
        rain: activeQuery.rain,
      });
    }
    return sortLooksByTakenAtDesc(candidates);
  }, [looks, activeQuery]);

  function handleSearch() {
    const maxTrim = maxInput.trim();
    const minTrim = minInput.trim();
    const maxProvided = maxTrim !== "";
    const minProvided = minTrim !== "";

    // 최고/최저 중 하나만 입력한 경우만 오류 - 둘 다 비우면 "기온 조건 없음"으로 취급한다.
    if (maxProvided !== minProvided) {
      setValidationError("최고기온과 최저기온을 모두 입력해 주세요.");
      return;
    }

    let hasTemp = false;
    if (maxProvided && minProvided) {
      const maxNum = Number(maxTrim);
      const minNum = Number(minTrim);
      if (!Number.isFinite(maxNum) || !Number.isFinite(minNum)) {
        setValidationError("최고기온과 최저기온을 모두 입력해 주세요.");
        return;
      }
      if (maxNum <= minNum) {
        setValidationError("최고기온은 최저기온보다 높게 입력해 주세요.");
        return;
      }
      hasTemp = true;
    }

    // 기온/비/꾸밈레벨 어떤 조건도 고르지 않았다면 오류 없이 그냥 검색을
    // 닫고 기존 전체 룩 화면으로 돌아간다.
    if (!hasTemp && rain === "any" && dressFilter === "all") {
      setValidationError(null);
      setSearchOpen(false);
      if (isWeatherSearchMode) router.push(pathname);
      return;
    }

    setValidationError(null);
    const tempQuery = hasTemp ? `max=${encodeURIComponent(maxTrim)}&min=${encodeURIComponent(minTrim)}&` : "";
    router.push(`${pathname}?mode=weather&${tempQuery}rain=${rain}&dress=${dressFilter}`);
  }

  function closeSearch() {
    setSearchOpen(false);
    setValidationError(null);
    if (isWeatherSearchMode) router.push(pathname);
  }

  const searchLinkQuery = activeQuery
    ? `from=looks&mode=weather&${
        activeQuery.targetMax !== null && activeQuery.targetMin !== null
          ? `max=${encodeURIComponent(String(activeQuery.targetMax))}&min=${encodeURIComponent(
              String(activeQuery.targetMin)
            )}&`
          : ""
      }rain=${activeQuery.rain}&dress=${activeQuery.dressLevel}`
    : "";

  return (
    <div className="mx-auto max-w-2xl px-3 pb-10 pt-10 sm:px-5">
      <header className="mb-6 px-2">
        <p className="text-xs font-medium tracking-wide text-neutral-400">
          LOOKIE
        </p>
        {/* "전체 룩 ···"와 "룩 찾기"의 세로 중심을 같은 줄에 맞추기 위해
            이 행 하나를 items-center flex row로 묶는다(LOOKIE 라벨은 그
            위에 별도 줄로 유지). */}
        <div className="mt-1 flex items-center justify-between">
          <div className="flex items-center gap-0.5">
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
          {/* 검색 패널을 펼치는 진입점은 눈에 띄는 pill로, 접을 때(닫기)는
              같은 자리에서 보조 텍스트 액션으로 가볍게 바뀐다 - border/배경
              없이 충분한 터치 영역만 확보한다. */}
          {searchOpen ? (
            <button
              type="button"
              onClick={() => setSearchOpen(false)}
              className="shrink-0 px-2 py-2 text-xs font-medium text-neutral-500"
            >
              닫기
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="shrink-0 rounded-full border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700"
            >
              룩 찾기
            </button>
          )}
        </div>
      </header>

      {/* 룩 찾기 패널 - 기온/비/꾸밈레벨 중 필요한 조건만 골라 검색하는
          화면이다("기온 입력 폼"이 아니라 여러 조건 중 선택). 숫자 키패드가
          뜨도록 inputMode="decimal"을 쓰고, 소수점도 허용한다. */}
      {searchOpen && (
        <section className="mb-6 rounded-2xl border border-neutral-100 p-4">
          <div>
            <span className="text-xs text-neutral-500">기온</span>
            <div className="mt-1.5 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] text-neutral-400">최고</span>
                <div className="mt-1 flex items-center rounded-lg bg-neutral-50 px-3 py-1.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={maxInput}
                    onChange={(e) => setMaxInput(e.target.value)}
                    className="w-full text-sm text-neutral-900 outline-none"
                  />
                  <span className="text-sm text-neutral-400">°C</span>
                </div>
              </label>
              <label className="block">
                <span className="text-[11px] text-neutral-400">최저</span>
                <div className="mt-1 flex items-center rounded-lg bg-neutral-50 px-3 py-1.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={minInput}
                    onChange={(e) => setMinInput(e.target.value)}
                    className="w-full text-sm text-neutral-900 outline-none"
                  />
                  <span className="text-sm text-neutral-400">°C</span>
                </div>
              </label>
            </div>
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
            룩 찾기
          </button>
        </section>
      )}

      {activeQuery ? (
        <section>
          <div className="flex items-center justify-between px-2">
            <h2 className="text-sm font-medium text-neutral-800">
              {searchResultTitle(activeQuery)}
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
