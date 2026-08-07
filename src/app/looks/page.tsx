"use client";

import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";

export default function LooksPage() {
  const { looks, looksLoading } = useApp();

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

      {looksLoading && looks.length === 0 && (
        <p className="mt-10 text-center text-xs text-neutral-400">
          불러오는 중…
        </p>
      )}

      {!looksLoading && looks.length === 0 && (
        <p className="mt-10 text-center text-xs text-neutral-300">
          아직 저장된 룩이 없습니다
        </p>
      )}

      <div className="grid grid-cols-3 gap-1.5">
        {looks.map((look) => (
          <Link
            key={look.id}
            href={`/looks/${look.id}`}
            className="relative block aspect-square overflow-hidden rounded-lg bg-neutral-100"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={look.imageUrl}
              alt=""
              className="h-full w-full object-cover"
            />
            {look.takenAt && (
              <span className="absolute bottom-1 left-1 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white">
                {formatDateOnly(look.takenAt.toDate())}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
