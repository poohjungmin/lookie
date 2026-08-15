"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";
import LookThumbImage from "@/components/LookThumbImage";
import {
  isWeatherMissing,
  recoverMissingWeather,
  type BulkWeatherRecoveryProgress,
  type BulkWeatherRecoveryResult,
} from "@/lib/bulkWeatherRecovery";

export default function LooksPage() {
  const { user, looks, syncing, patchLookWeather } = useApp();

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

  return (
    <div className="mx-auto max-w-2xl px-3 pb-10 pt-10 sm:px-5">
      <header className="mb-6 px-2">
        <p className="text-xs font-medium tracking-wide text-neutral-400">
          LOOKIE
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          전체 룩
        </h1>
      </header>

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
    </div>
  );
}
