"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useApp } from "@/lib/AppContext";
import { formatDateOnly } from "@/lib/format";
import { regenerateLookCutout } from "@/lib/regenerateCutout";

export default function LookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, looks, syncing, deleteLook, refreshLooks } = useApp();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [regenerateDone, setRegenerateDone] = useState(false);

  const look = looks.find((l) => l.id === id);

  if (!look) {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
        <p className="text-sm text-neutral-400">
          {syncing ? "불러오는 중…" : "룩을 찾을 수 없습니다"}
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

  async function handleRegenerateCutout() {
    if (!look) return;
    setRegenerating(true);
    setRegenerateError(null);
    setRegenerateDone(false);
    try {
      await regenerateLookCutout(user.uid, look);
      await refreshLooks();
      setRegenerateDone(true);
    } catch (err) {
      setRegenerateError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegenerating(false);
    }
  }

  async function handleConfirmDelete() {
    if (!look) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteLook(look.id);
      // 목록/캘린더/홈은 공용 Context 상태를 쓰므로 삭제 즉시 거기서도 사라진다.
      router.replace("/looks");
    } catch (err) {
      setDeleting(false);
      setDeleteError(
        `삭제에 실패했어요: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
        <button
          type="button"
          onClick={() => {
            setDeleteError(null);
            setConfirmOpen(true);
          }}
          aria-label="룩 삭제"
          className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-neutral-700 shadow"
        >
          {/* 휴지통 아이콘 */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16" />
            <path d="M9 7V4h6v3" />
            <path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
            <path d="M10 11v6M14 11v6" />
          </svg>
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

        {/* 누끼가 잘못 잘렸거나 배경이 안 지워졌을 때, 개발 도구를 거치지
            않고 이 사진만 바로 다시 처리할 수 있는 버튼. */}
        <div className="mt-4 rounded-2xl border border-neutral-100 p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-neutral-700">누끼 이미지</p>
            <span className="text-xs text-neutral-400">
              {look.cutoutUrl ? "생성됨" : "없음"}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-400">
            사람이 이상하게 잘렸거나 배경이 안 지워졌다면 다시 생성해보세요.
          </p>
          <button
            type="button"
            onClick={handleRegenerateCutout}
            disabled={regenerating}
            className="mt-3 w-full rounded-xl border border-neutral-300 py-2.5 text-center text-sm font-medium text-neutral-800 disabled:opacity-50"
          >
            {regenerating ? "누끼 다시 생성 중…" : "🔄 누끼 다시 생성"}
          </button>
          {regenerateDone && (
            <p className="mt-2 text-xs text-neutral-500">다시 생성했어요.</p>
          )}
          {regenerateError && (
            <p className="mt-2 text-xs text-red-600">실패: {regenerateError}</p>
          )}
        </div>

        {/* 향후 카테고리·꾸밈 정도 표시 공간 (Vision AI 붙기 전까지는 비워둠) */}
        <div className="mt-4 rounded-2xl border border-dashed border-neutral-200 p-5 text-center text-xs text-neutral-300">
          카테고리 · 꾸밈 정도 (준비 중)
        </div>
      </div>

      {/* 삭제 확인 모달 - 실수 방지를 위해 상세화면 → 삭제 아이콘 → 확인,
          반드시 2단계를 거치게 한다 (탭 한 번으로 바로 삭제하지 않음). */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-sm rounded-t-3xl bg-white p-6 sm:rounded-3xl">
            <p className="text-base font-semibold text-neutral-900">
              이 룩을 삭제할까요?
            </p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-500">
              사진과 해당 날짜의 룩 기록이 모두 삭제됩니다.
            </p>
            {deleteError && (
              <p className="mt-3 text-xs text-red-600">{deleteError}</p>
            )}
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={deleting}
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium text-neutral-700 disabled:opacity-50"
              >
                취소
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={deleting}
                className="flex-1 rounded-2xl bg-red-600 py-3 text-sm font-medium text-white disabled:bg-red-300"
              >
                {deleting ? "삭제 중…" : "삭제"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
