"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import type { DisplayLook } from "@/lib/useLocalFirstLooks";
import LookThumbImage from "@/components/LookThumbImage";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** dateKey는 getMonth()(0-11, 0-인덱스)를 그대로 담고 있으므로, 표시할 때는 +1 해야 한다. */
function formatDateKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return `${y}.${String(m + 1).padStart(2, "0")}.${String(d).padStart(2, "0")}`;
}

function buildMonthGrid(year: number, month: number): (Date | null)[] {
  const firstDay = new Date(year, month, 1);
  const startWeekday = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (Date | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export default function HistoryPage() {
  const { looks, syncing } = useApp();
  const today = new Date();

  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const looksByDay = useMemo(() => {
    const map = new Map<string, DisplayLook[]>();
    for (const look of looks) {
      if (!look.takenAt) continue;
      const key = dateKey(look.takenAt.toDate());
      const list = map.get(key) ?? [];
      list.push(look);
      map.set(key, list);
    }
    return map;
  }, [looks]);

  const cells = useMemo(
    () => buildMonthGrid(viewYear, viewMonth),
    [viewYear, viewMonth]
  );
  const selectedLooks = selectedKey ? looksByDay.get(selectedKey) ?? [] : [];

  function goPrevMonth() {
    setSelectedKey(null);
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function goNextMonth() {
    setSelectedKey(null);
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-3 pb-10 pt-10 sm:px-6">
      <header className="mb-6 px-2">
        <p className="text-xs font-medium tracking-wide text-neutral-400">
          LOOKIE
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          캘린더
        </h1>
      </header>

      <div className="flex items-center justify-between px-3">
        <button
          type="button"
          onClick={goPrevMonth}
          aria-label="이전 달"
          className="p-2 text-lg text-neutral-300"
        >
          ‹
        </button>
        <p className="text-sm font-medium text-neutral-700">
          {viewYear}년 {viewMonth + 1}월
        </p>
        <button
          type="button"
          onClick={goNextMonth}
          aria-label="다음 달"
          className="p-2 text-lg text-neutral-300"
        >
          ›
        </button>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1 px-1 text-center text-[10px] text-neutral-300">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>

      {/* 전신 누끼가 잘 보이도록 정사각형이 아니라 세로로 긴 카드 비율을
          쓴다 (가로 대비 세로 약 1.4배). 누끼는 position:absolute로 셀
          전체를 채우고(발은 bottom 기준 정렬), 정규화된 누끼 안의 여백
          때문에 작아 보이지 않도록 표시 단계에서만 살짝 더 확대한다
          (scale 1.15, 셀 밖으로 나가는 부분은 overflow-hidden으로 클립).
          날짜 숫자는 누끼 위에 겹쳐서 z-index로 올린다. */}
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((date, i) => {
          if (!date) return <div key={i} />;
          const key = dateKey(date);
          const dayLooks = looksByDay.get(key);
          const extraCount = dayLooks ? dayLooks.length - 1 : 0;
          const isSelected = key === selectedKey;
          const isToday = dateKey(today) === key;

          return (
            <button
              key={i}
              type="button"
              onClick={() => setSelectedKey(isSelected ? null : key)}
              className={
                "relative aspect-[1/1.4] overflow-hidden rounded-lg bg-neutral-50 " +
                (isSelected ? "ring-2 ring-neutral-900" : "")
              }
            >
              <span
                className={
                  "absolute left-1 top-0.5 z-10 text-[10px] leading-tight " +
                  (isToday ? "font-semibold text-neutral-900" : "text-neutral-400")
                }
              >
                {date.getDate()}
              </span>

              {dayLooks && dayLooks[0] && (
                <>
                  <LookThumbImage
                    look={dayLooks[0]}
                    className="absolute inset-x-0 bottom-0 h-full w-full origin-bottom scale-[1.15] object-contain object-bottom"
                  />
                  {extraCount > 0 && (
                    <span className="absolute bottom-0.5 right-0.5 z-10 rounded-full bg-neutral-900/80 px-1 text-[9px] leading-4 text-white">
                      +{extraCount}
                    </span>
                  )}
                </>
              )}
            </button>
          );
        })}
      </div>

      {selectedKey && (
        <section className="mt-8 border-t border-neutral-100 px-2 pt-6">
          <h2 className="text-sm font-medium text-neutral-700">
            {formatDateKey(selectedKey)}
          </h2>
          {selectedLooks.length === 0 ? (
            <p className="mt-4 text-center text-xs text-neutral-300">
              이 날 저장된 룩이 없습니다
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-4">
              {selectedLooks.map((look) => (
                <Link key={look.id} href={`/looks/${look.id}`} className="block">
                  <div className="aspect-[3/4] overflow-hidden rounded-2xl bg-neutral-50">
                    <LookThumbImage look={look} className="h-full w-full object-contain" />
                  </div>
                  <p className="mt-2 text-center text-[11px] text-neutral-500">
                    {look.weatherStatus === "success" && look.weather
                      ? [
                          look.weather.weatherLabel,
                          look.weather.tempMax !== null && look.weather.tempMin !== null
                            ? `최고 ${look.weather.tempMax.toFixed(1)}℃ · 최저 ${look.weather.tempMin.toFixed(1)}℃`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "날씨 정보 없음"}
                  </p>
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {syncing && (
        <p className="mt-6 text-center text-xs text-neutral-400">
          불러오는 중…
        </p>
      )}
    </div>
  );
}
