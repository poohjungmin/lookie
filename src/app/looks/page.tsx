"use client";

import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";
import LookThumbImage from "@/components/LookThumbImage";

export default function LooksPage() {
  const { looks, syncing } = useApp();

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
          <Link key={look.id} href={`/looks/${look.id}`} className="block">
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
