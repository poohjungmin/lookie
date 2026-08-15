"use client";

import Link from "next/link";
import type { DisplayLook } from "@/lib/useLocalFirstLooks";
import { formatDateOnly } from "@/lib/format";
import LookThumbImage from "@/components/LookThumbImage";

/**
 * "오늘과 비슷한 날씨에 입었던 룩" / "이맘때 입었던 룩" 가로 스크롤 목록에
 * 쓰는 카드. 이미지 우선순위는 LookThumbImage가 이미 처리하는 기존 순서
 * (IndexedDB 캐시된 누끼 썸네일 -> cutoutThumbnailUrl -> thumbnailUrl ->
 * imageUrl)를 그대로 따른다 - 이 화면을 위해 별도로 이미지를 미리 받지 않는다.
 * similarity score는 내부 랭킹 전용이라 여기서도 표시하지 않는다.
 */
export default function RecommendedLookCard({ look }: { look: DisplayLook }) {
  const tempMax = look.weather?.tempMax ?? null;
  const tempMin = look.weather?.tempMin ?? null;

  return (
    <Link href={`/looks/${look.id}`} className="block w-28 shrink-0 sm:w-32">
      <div className="aspect-[3/4] overflow-hidden rounded-2xl bg-neutral-50">
        <LookThumbImage look={look} className="h-full w-full object-contain" />
      </div>
      <div className="mt-2 text-center">
        <p className="text-[10px] text-neutral-400">
          {look.takenAt ? formatDateOnly(look.takenAt.toDate()) : ""}
        </p>
        {(tempMax !== null || tempMin !== null) && (
          <p className="text-xs font-medium text-neutral-700">
            {tempMax !== null ? `${Math.round(tempMax)}°` : "-"}
            {" / "}
            {tempMin !== null ? `${Math.round(tempMin)}°` : "-"}
          </p>
        )}
        {look.weather?.weatherLabel && (
          <p className="text-[10px] text-neutral-400">{look.weather.weatherLabel}</p>
        )}
      </div>
    </Link>
  );
}
