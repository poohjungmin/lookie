"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import type { SavedLook } from "@/lib/lookStore";

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
  const { looks, looksLoading } = useApp();
  const today = new Date();

  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const looksByDay = useMemo(() => {
    const map = new Map<string, SavedLook[]>();
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
    <div className="mx-auto max-w-2xl px-5 pb-10 pt-10 sm:px-6">
      <header className="mb-6">
        <p className="text-xs font-medium tracking-wide text-neutral-400">
          LOOKIE
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          히스토리
        </h1>
      </header>

      <div className="flex items-center justify-between px-1">
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

      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[11px] text-neutral-300">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-1.5">
        {cells.map((date, i) => {
          if (!date) return <div key={i} />;
          const key = dateKey(date);
          const dayLooks = looksByDay.get(key);
          const isSelected = key === selectedKey;
          const isToday = dateKey(today) === key;

          return (
            <button
              key={i}
              type="button"
              onClick={() => setSelectedKey(isSelected ? null : key)}
              className={
                "relative flex aspect-square items-center justify-center overflow-hidden rounded-lg text-xs " +
                (isSelected ? "ring-2 ring-neutral-900" : "")
              }
            >
              {dayLooks && dayLooks[0] ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={dayLooks[0].imageUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute bottom-0.5 right-0.5 rounded bg-black/50 px-1 text-[9px] leading-4 text-white">
                    {date.getDate()}
                  </span>
                </>
              ) : (
                <span
                  className={
                    isToday ? "font-semibold text-neutral-900" : "text-neutral-400"
                  }
                >
                  {date.getDate()}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {selectedKey && (
        <section className="mt-8 border-t border-neutral-100 pt-6">
          <h2 className="text-sm font-medium text-neutral-700">
            {selectedKey.split("-").map(Number).join(".")}
          </h2>
          {selectedLooks.length === 0 ? (
            <p className="mt-4 text-center text-xs text-neutral-300">
              이 날 저장된 룩이 없습니다
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-3 gap-2">
              {selectedLooks.map((look) => (
                <Link
                  key={look.id}
                  href={`/looks/${look.id}`}
                  className="block aspect-square overflow-hidden rounded-xl bg-neutral-100"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={look.imageUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </Link>
              ))}
            </div>
          )}
        </section>
      )}

      {looksLoading && (
        <p className="mt-6 text-center text-xs text-neutral-400">
          불러오는 중…
        </p>
      )}
    </div>
  );
}
