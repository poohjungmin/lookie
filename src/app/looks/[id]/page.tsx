"use client";

import { useParams, useRouter } from "next/navigation";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";

export default function LookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { looks, looksLoading } = useApp();

  const look = looks.find((l) => l.id === id);

  if (!look) {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
        <p className="text-sm text-neutral-400">
          {looksLoading ? "불러오는 중…" : "룩을 찾을 수 없습니다"}
        </p>
        <button
          type="button"
          onClick={() => router.back()}
          className="mt-4 text-sm text-neutral-500 underline underline-offset-2"
        >
          돌아가기
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <div className="relative">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="뒤로"
          className="absolute left-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow"
        >
          ←
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={look.imageUrl} alt="" className="w-full object-cover" />
      </div>

      <div className="px-5 pt-6 sm:px-6">
        <p className="text-lg font-semibold text-neutral-900">
          {look.takenAt ? formatDateOnly(look.takenAt.toDate()) : "촬영일 정보 없음"}
        </p>

        <div className="mt-4 rounded-2xl bg-neutral-50 p-5">
          {look.weatherStatus === "success" && look.weather ? (
            <div className="space-y-1.5 text-sm text-neutral-600">
              <p className="text-base font-medium text-neutral-800">
                {look.weather.weatherLabel ?? "-"}
              </p>
              <p>
                최고{" "}
                {look.weather.tempMax !== null
                  ? `${look.weather.tempMax.toFixed(1)}℃`
                  : "-"}{" "}
                · 최저{" "}
                {look.weather.tempMin !== null
                  ? `${look.weather.tempMin.toFixed(1)}℃`
                  : "-"}
              </p>
              <p className="text-neutral-400">
                강수{" "}
                {look.weather.precipitation !== null
                  ? `${look.weather.precipitation}mm`
                  : "정보 없음"}
              </p>
            </div>
          ) : (
            <p className="text-sm text-neutral-400">
              {look.weatherStatus === "failed"
                ? "날씨 조회에 실패했어요"
                : "이 룩에는 날씨 정보가 없어요"}
            </p>
          )}
        </div>

        {/* 향후 카테고리·꾸밈 정도 표시 공간 (Vision AI 붙기 전까지는 비워둠) */}
        <div className="mt-4 rounded-2xl border border-dashed border-neutral-200 p-5 text-center text-xs text-neutral-300">
          카테고리 · 꾸밈 정도 (준비 중)
        </div>
      </div>
    </div>
  );
}
