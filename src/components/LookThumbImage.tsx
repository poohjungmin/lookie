"use client";

import { useState } from "react";
import type { DisplayLook } from "@/lib/useLocalFirstLooks";

/**
 * thumbSrc(IndexedDB 캐시 Blob 또는 원격 URL 중 우선순위로 고른 하나)가
 * 이 순간 로드에 실패해도(끊긴 캐시 Blob object URL, 일시적 네트워크 문제,
 * CORS 등) 깨진 이미지 아이콘만 덩그러니 보이지 않도록, 다음으로 나은
 * 후보 URL로 자동으로 넘어간다: thumbSrc → cutoutThumbnailUrl →
 * thumbnailUrl → imageUrl. 전부 실패하면 조용히 아무것도 렌더링하지 않는다
 * (부모의 배경색만 보임 - "?" 아이콘보다 낫다).
 */
export default function LookThumbImage({
  look,
  className,
  alt = "",
}: {
  look: DisplayLook;
  className?: string;
  alt?: string;
}) {
  const candidates = [look.thumbSrc, look.cutoutThumbnailUrl, look.thumbnailUrl, look.imageUrl].filter(
    (v, i, arr): v is string => !!v && arr.indexOf(v) === i
  );
  const [idx, setIdx] = useState(0);

  const src = candidates[idx];
  if (!src) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      onError={() => {
        setIdx((i) => (i + 1 < candidates.length ? i + 1 : i));
      }}
    />
  );
}
