"use client";

import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";

function todayKorean(): string {
  return new Date().toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

export default function HomePage() {
  const { looks, syncing, signOutUser } = useApp();

  // 아직 "비슷한 날씨" 추천 로직이 없으므로, 최근 저장한 룩을 자리표시자로 보여준다.
  const placeholderPicks = looks.slice(0, 4);

  return (
    <div className="mx-auto max-w-2xl px-5 pb-10 pt-10 sm:px-6">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <p className="text-xs font-medium tracking-wide text-neutral-400">
            LOOKIE
          </p>
          <h1 className="mt-1 text-xl font-semibold text-neutral-900">
            {todayKorean()}
          </h1>
        </div>
        <button
          type="button"
          onClick={signOutUser}
          className="mt-1 text-xs text-neutral-300 underline underline-offset-2"
        >
          로그아웃
        </button>
      </header>

      {/* 현재 날씨 - 다음 단계에서 실제 API를 연결할 자리 */}
      <section className="rounded-3xl bg-neutral-50 px-6 py-10 text-center">
        <p className="text-xs text-neutral-400">현재 날씨</p>
        <p className="mt-3 text-sm text-neutral-300">날씨 정보 준비 중</p>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium text-neutral-800">
          오늘과 비슷한 날씨에 입었던 룩
        </h2>
        <p className="mt-1 text-xs text-neutral-300">
          추천 기능은 준비 중이에요. 최근 저장한 룩을 먼저 보여드려요.
        </p>

        {syncing && placeholderPicks.length === 0 && (
          <p className="mt-8 text-center text-xs text-neutral-400">
            불러오는 중…
          </p>
        )}

        {!syncing && placeholderPicks.length === 0 && (
          <p className="mt-8 text-center text-xs text-neutral-300">
            아직 저장된 룩이 없어요. + 버튼으로 첫 룩을 추가해보세요.
          </p>
        )}

        {placeholderPicks.length > 0 && (
          <div className="mt-5 grid grid-cols-2 gap-3">
            {placeholderPicks.map((look) => (
              <Link
                key={look.id}
                href={`/looks/${look.id}`}
                className="block overflow-hidden rounded-2xl bg-neutral-100"
              >
                <div className="aspect-[3/4]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={look.thumbSrc}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </div>
                <p className="px-2.5 py-2 text-[11px] text-neutral-400">
                  {look.takenAt ? formatDateOnly(look.takenAt.toDate()) : ""}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
