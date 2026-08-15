"use client";

import { useEffect, useRef, useState } from "react";
import type { DisplayLook } from "@/lib/useLocalFirstLooks";

/**
 * 상세 화면 상단 이미지 영역. 1페이지 = 누끼(즉시 캐시로 페인트, 상세 해상도가
 * 도착하면 조용히 교체), 2페이지 = 원본(백그라운드에서 미리 받아둔다). 누끼가
 * 아예 없는 룩은 스와이프 없이 원본 한 장만 보여준다.
 *
 * 무거운 carousel 라이브러리 없이 CSS scroll-snap만으로 구현 - flex +
 * overflow-x-auto + snap-x mandatory + 각 페이지 shrink-0 w-full. 컨테이너가
 * 고정 높이라 가로 스와이프와 페이지 세로 스크롤이 서로 간섭하지 않는다.
 */
export default function LookDetailGallery({ look }: { look: DisplayLook }) {
  const hasCutout = !!(look.cutoutUrl || look.cutoutThumbnailUrl);

  // 진입 즉시 보여줄 소스 - useLocalFirstLooks가 이미 만들어둔 thumbSrc는
  // IndexedDB 캐시(있으면 누끼 우선) → 원격 누끼 썸네일 → 썸네일 → 원본 순으로
  // 폴백되어 있으므로, 네트워크를 기다리지 않고 바로 화면을 채울 수 있다.
  const [cutoutSrc, setCutoutSrc] = useState(look.thumbSrc);
  const [originalSrc, setOriginalSrc] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- look(id)이 바뀔 때마다
       화면을 그 룩의 캐시된 썸네일로 다시 초기화하는 의도적인 동기화다
       (상세 화면들 사이를 직접 이동하는 경로가 생기더라도 안전하게 동작). */
    setCutoutSrc(look.thumbSrc);
    setPageIndex(0);
    scrollerRef.current?.scrollTo({ left: 0 });
    /* eslint-enable react-hooks/set-state-in-effect */

    let cancelled = false;

    // 상세 해상도 누끼가 캐시 썸네일과 다르면, 다 받아진 뒤에만 교체해서
    // 빈 화면/깜빡임 없이 자연스럽게 업그레이드한다.
    const bestCutoutUrl = look.cutoutUrl ?? look.cutoutThumbnailUrl ?? null;
    if (bestCutoutUrl && bestCutoutUrl !== look.thumbSrc) {
      const img = new window.Image();
      img.onload = () => {
        if (!cancelled) setCutoutSrc(bestCutoutUrl);
      };
      img.src = bestCutoutUrl;
    }

    // 원본은 화면에 바로 안 보여줘도 되니 뒤에서 미리 받아둔다 - 사용자가
    // 옆으로 넘길 즈음엔 이미 브라우저 캐시에 있어 즉시 표시된다. 실패해도
    // (네트워크 문제 등) 조용히 두고, 페이지 2는 안내 문구만 보여준다.
    setOriginalSrc(null);
    const original = new window.Image();
    original.onload = () => {
      if (!cancelled) setOriginalSrc(look.imageUrl);
    };
    original.onerror = () => {
      // 실패해도 src는 그대로 넣어둔다 - <img>가 다시 한번 자체적으로 시도하고,
      // 그마저 실패하면 alt 없는 빈 자리만 남아 화면 자체는 깨지지 않는다.
      if (!cancelled) setOriginalSrc(look.imageUrl);
    };
    original.src = look.imageUrl;

    return () => {
      cancelled = true;
    };
  }, [look.id, look.thumbSrc, look.cutoutUrl, look.cutoutThumbnailUrl, look.imageUrl]);

  function handleScroll() {
    const el = scrollerRef.current;
    if (!el || el.clientWidth === 0) return;
    setPageIndex(Math.round(el.scrollLeft / el.clientWidth));
  }

  if (!hasCutout) {
    // 누끼가 없으면 스와이프할 두 번째 페이지의 의미가 없으니 원본 한 장만.
    return (
      <div className="aspect-[4/5] w-full bg-neutral-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={look.imageUrl} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
      >
        <div className="aspect-[4/5] w-full shrink-0 snap-start bg-neutral-50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cutoutSrc} alt="" className="h-full w-full object-contain" />
        </div>
        <div className="aspect-[4/5] w-full shrink-0 snap-start bg-neutral-100">
          {originalSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={originalSrc} alt="" className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <p className="text-xs text-neutral-300">원본 불러오는 중…</p>
            </div>
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${pageIndex === 0 ? "bg-white" : "bg-white/40"}`} />
        <span className={`h-1.5 w-1.5 rounded-full ${pageIndex === 1 ? "bg-white" : "bg-white/40"}`} />
      </div>
    </div>
  );
}
