"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import type { DisplayLook } from "@/lib/useLocalFirstLooks";

const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
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
          쓴다 (가로 대비 세로 약 1.4배). 날짜 숫자는 상단에 작게,
          누끼는 셀 중앙~하단에 object-contain으로 채운다. */}
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
                "relative flex aspect-[1/1.4] flex-col overflow-hidden rounded-lg bg-neutral-50 " +
                (isSelected ? "ring-2 ring-neutral-900" : "")
              }
            >
              <span
                className={
                  "px-1 pt-0.5 text-left text-[10px] leading-tight " +
                  (isToday ? "font-semibold text-neutral-900" : "text-neutral-400")
                }
              >
                {date.getDate()}
              </span>

              {dayLooks && dayLooks[0] && (
                <div className="relative flex-1 px-0.5 pb-0.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={dayLooks[0].thumbSrc}
                    alt=""
                    className="h-full w-full object-contain object-bottom"
                  />
                  {extraCount > 0 && (
                    <span className="absolute bottom-0.5 right-0.5 rounded-full bg-neutral-900/80 px-1 text-[9px] leading-4 text-white">
                      +{extraCount}
                    </span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {selectedKey && (
        <section className="mt-8 border-t border-neutral-100 px-2 pt-6">
          <h2 className="text-sm font-medium text-neutral-700">
            {selectedKey.split("-").map(Number).join(".")}
          </h2>
          {selectedLooks.length === 0 ? (
            <p className="mt-4 text-center text-xs text-neutral-300">
              이 날 저장된 룩이 없습니다
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-4">
              {selectedLooks.map((look) => (
                <Link
                  key={look.id}
                  href={`/looks/${look.id}`}
                  className="block aspect-[3/4] overflow-hidden rounded-2xl bg-neutral-50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={look.thumbSrc}
                    alt=""
                    className="h-full w-full object-contain"
                  />
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
