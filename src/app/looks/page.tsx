"use client";

import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";
import LookThumbImage from "@/components/LookThumbImage";

export default function LooksPage() {
  const { looks, syncing } = useApp();

  return (
    <div className="mx-auto max-w-2xl px-5 pb-10 pt-10 sm:px-6">
      <header className="mb-6">
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

      {/* SNS 피드 느낌을 피하려고 카드 간격을 넉넉히 두고, 배경을 흰색/연한
          회색으로 통일해 누끼 전신이 또렷이 보이게 한다 (object-contain). */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-6">
        {looks.map((look) => (
          <Link key={look.id} href={`/looks/${look.id}`} className="block">
            <div className="aspect-[3/4] overflow-hidden rounded-2xl bg-neutral-50">
              <LookThumbImage look={look} className="h-full w-full object-contain" />
            </div>
            {look.takenAt && (
              <p className="mt-2 text-center text-[11px] text-neutral-400">
                {formatDateOnly(look.takenAt.toDate())}
              </p>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
