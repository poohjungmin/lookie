"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import type { DisplayLook } from "@/lib/useLocalFirstLooks";
import { resolveLookDate } from "@/lib/lookDate";
import { updateLookDressLevel, type DressLevel } from "@/lib/lookStore";
import { DRESS_LEVELS, dressLevelLabel } from "@/lib/dressLevel";

/**
 * 화면에 크게 보여줄 이미지 - 목록에서 쓰는 thumbSrc(IndexedDB에 캐시된
 * 누끼 썸네일 우선, 없으면 원격 URL/썸네일/원본까지 이미 폴백되어 있는 값)로
 * 즉시 페인트하고, 더 큰 누끼(cutoutUrl 우선, 없으면 누끼 썸네일)가 따로
 * 있고 다 받아지면 그때만 조용히 교체한다 - 상세 화면 갤러리
 * (LookDetailGallery)와 같은 "즉시 캐시로 페인트 + 백그라운드 업그레이드"
 * 패턴을 재사용한다. 한 번에 룩 한 장만 크게 보여주는 화면이라 원본 등
 * 다른 이미지는 미리 받지 않는다.
 */
function useBigCutoutSrc(look: DisplayLook | null): string | null {
  const [src, setSrc] = useState<string | null>(look?.thumbSrc ?? null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- look(id)이 바뀔 때마다
       그 룩의 캐시된 썸네일로 화면을 다시 초기화하는 의도적인 동기화다
       (LookDetailGallery와 동일한 패턴). */
    if (!look) {
      setSrc(null);
      return;
    }
    setSrc(look.thumbSrc);
    /* eslint-enable react-hooks/set-state-in-effect */

    let cancelled = false;
    const betterUrl = look.cutoutUrl ?? look.cutoutThumbnailUrl ?? null;
    if (betterUrl && betterUrl !== look.thumbSrc) {
      const img = new window.Image();
      img.onload = () => {
        if (!cancelled) setSrc(betterUrl);
      };
      img.src = betterUrl;
    }

    return () => {
      cancelled = true;
    };
  }, [look]);

  return src;
}

export default function DressLevelPage() {
  const { user, looks, syncing, patchLookDressLevel } = useApp();

  const total = looks.length;

  // 미분류(dressLevel == null) 룩만, 촬영일 최신순 - 가장 최근 룩부터 하나씩.
  const queue = useMemo(() => {
    const unclassified = looks.filter((l) => l.dressLevel == null);
    return [...unclassified].sort((a, b) => {
      const at = resolveLookDate(a)?.getTime() ?? 0;
      const bt = resolveLookDate(b)?.getTime() ?? 0;
      return bt - at;
    });
  }, [looks]);

  const current = queue[0] ?? null;
  const classifiedCount = total - queue.length;

  // Undo history는 한 단계면 충분하다 - 새로 하나를 고르면 이전 undo는 사라진다.
  const [undo, setUndo] = useState<{ lookId: string; level: DressLevel; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const imageSrc = useBigCutoutSrc(current);

  // Firestore 저장이 실패하면 optimistic으로 먼저 반영해둔 local/캐시 값을
  // "이 patch 이전에 실제로 저장돼 있던 값"(previous)으로 되돌린다 - 화면상
  // 선택을 그대로 유지한 채 끝내면 Firestore와 local state가 어긋난 채로
  // 남는다. previous가 null이면(= 방금 새로 분류한 경우) 그 룩은 미분류
  // 큐에 자동으로 다시 나타난다. undo 배너가 이 룩을 가리키고 있었다면
  // 더는 되돌릴 게 없으므로 함께 정리한다.
  async function persist(lookId: string, level: DressLevel | null, previous: DressLevel | null) {
    try {
      await updateLookDressLevel(user.uid, lookId, level);
    } catch (err) {
      patchLookDressLevel(lookId, previous);
      setUndo((prev) => (prev?.lookId === lookId ? null : prev));
      setError(`저장하지 못했어요 · ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 버튼 탭 -> local/global state 즉시 반영 -> (큐가 다시 계산되며) 다음 룩
  // 즉시 표시 -> Firestore patch는 비동기로. 별도의 저장/확인/다음 버튼은 없다.
  function handlePick(level: DressLevel) {
    if (!current) return;
    const lookId = current.id;
    setError(null);
    patchLookDressLevel(lookId, level);
    setUndo({ lookId, level, label: dressLevelLabel(level) });
    void persist(lookId, level, null);
  }

  function handleUndo() {
    if (!undo) return;
    const { lookId, level } = undo;
    setError(null);
    patchLookDressLevel(lookId, null);
    setUndo(null);
    void persist(lookId, null, level);
  }

  if (syncing && total === 0) {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
        <p className="text-sm text-neutral-400">불러오는 중…</p>
      </div>
    );
  }

  if (total === 0) {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
        <p className="text-sm text-neutral-300">아직 저장된 룩이 없어요.</p>
        <Link
          href="/looks"
          className="mt-4 inline-block text-sm text-neutral-500 underline underline-offset-2"
        >
          전체 룩으로 돌아가기
        </Link>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center px-5 pt-24 text-center sm:px-6">
        <h1 className="text-2xl font-semibold text-neutral-900">다 정했다 ✨</h1>
        <p className="mt-2 text-sm text-neutral-500">모든 룩의 꾸밈레벨을 정했어요.</p>
        <Link
          href="/looks"
          className="mt-8 rounded-2xl bg-neutral-900 px-6 py-3 text-sm font-medium text-white"
        >
          전체 룩으로 돌아가기
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pt-10 pb-8 sm:px-6">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-neutral-400">LOOKIE</p>
          <h1 className="mt-1 text-xl font-semibold text-neutral-900">꾸밈레벨</h1>
        </div>
        <Link
          href="/looks"
          className="mt-1 shrink-0 text-xs text-neutral-400 underline underline-offset-2"
        >
          닫기
        </Link>
      </header>

      <p className="mt-1 text-xs text-neutral-400">
        {classifiedCount} / {total} 완료
      </p>

      <p className="mt-8 text-sm text-neutral-500">이날은 얼마나 꾸몄지?</p>

      <div className="mt-4 aspect-[4/5] w-full overflow-hidden rounded-2xl bg-neutral-50">
        {imageSrc && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageSrc} alt="" className="h-full w-full object-contain" />
        )}
      </div>

      {undo && (
        <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-neutral-500">
          <span>{undo.label}로 정했어요</span>
          <button
            type="button"
            onClick={handleUndo}
            className="font-medium text-neutral-800 underline underline-offset-2"
          >
            방금 선택 취소
          </button>
        </div>
      )}
      {error && <p className="mt-3 text-center text-xs text-red-600">{error}</p>}

      {/* 세 버튼 중 하나를 누르는 순간 바로 다음 룩으로 넘어간다 - 각 단계가
          무엇을 의미하는지는 사용자 본인의 기준이므로 별도 설명은 붙이지 않는다. */}
      <div className="mt-5 grid grid-cols-3 gap-3">
        {DRESS_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => handlePick(level)}
            className="rounded-2xl border-2 border-neutral-900 py-7 text-base font-semibold text-neutral-900 active:bg-neutral-900 active:text-white"
          >
            {dressLevelLabel(level)}
          </button>
        ))}
      </div>
    </div>
  );
}
