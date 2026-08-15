"use client";

import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import { generateCutout, CURRENT_CUTOUT_VERSION } from "@/lib/cutout";
import {
  uploadLookCutout,
  uploadLookCutoutThumbnail,
  updateLookCutoutFields,
} from "@/lib/lookStore";

/*
 * 개발용 도구 — Storage에 남아있는 original 이미지로 cutout/cutout-thumb를
 * 최신 정규화 알고리즘으로 다시 만들어 덮어쓰는 일괄 재처리 도구.
 * cutoutVersion이 CURRENT_CUTOUT_VERSION보다 낮은(또는 아예 없는) 룩만
 * 대상으로 삼고, 이미 최신인 룩은 건너뛴다.
 *
 * 접근 제어: 이 페이지도 다른 모든 페이지와 마찬가지로 루트 레이아웃의
 * AppShell(Google 로그인 게이트) 안에서만 렌더링된다 - useApp()은 로그인
 * 전에는 아예 호출될 수 없다. 여기서 쓰는 user.uid는 항상 "현재 로그인한
 * 본인"이고, looks도 그 uid로만 조회된 목록이라 다른 사용자의
 * users/{uid}/looks/*  데이터에는 애초에 접근할 수 없다. Firestore/Storage
 * 보안 규칙도 동일하게 request.auth.uid == uid만 허용해 이중으로 막는다.
 *
 * 절대 건드리지 않는 것: Firestore 문서 삭제, lookId, createdAt, 날씨,
 * EXIF(위경도/촬영일) - 오직 Storage의 cutout/cutout-thumb 파일과 Firestore의
 * cutoutUrl/cutoutThumbnailUrl/(관련 storagePath)/cutoutVersion/updatedAt만 바뀐다.
 *
 * 한 번에 전부 Promise.all로 돌리지 않고 for...of로 한 장씩 순차 처리한다
 * (generateCutout 자체도 앱 전체에서 직렬화되어 있지만, 원본 다운로드 등
 * 다른 단계까지 겹치지 않도록 여기서도 한 번에 한 장만 진행한다) -
 * 사진이 많아도(수백~수천 장) iPhone 메모리 사용량이 폭증하지 않게 하기 위함.
 *
 * 마이그레이션이 끝나면 이 상수를 false로 바꿔 production에서 다시
 * 숨긴다 (라우트 자체를 지우지 않아도 즉시 비활성화 가능).
 */
const ENABLE_CUTOUT_MIGRATION = true;

type ItemStatus = "pending" | "downloading" | "generating" | "uploading" | "done" | "skipped" | "error";

type Item = {
  id: string;
  imageUrl: string;
  status: ItemStatus;
  error?: string;
};

export default function CutoutMigratePage() {
  const { user, looks, refreshLooks } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const [finished, setFinished] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const pendingLooks = looks.filter((l) => (l.cutoutVersion ?? 0) < CURRENT_CUTOUT_VERSION);

  function updateItem(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function start() {
    setConfirmOpen(false);
    if (running) return;
    const targets = pendingLooks;
    if (targets.length === 0) return;

    setItems(targets.map((look) => ({ id: look.id, imageUrl: look.imageUrl, status: "pending" })));
    setProcessedCount(0);
    setFinished(false);
    setRunning(true);

    for (const look of targets) {
      try {
        updateItem(look.id, { status: "downloading" });
        const res = await fetch(look.imageUrl);
        if (!res.ok) throw new Error(`원본 다운로드 실패 (HTTP ${res.status})`);
        const originalBlob = await res.blob();

        updateItem(look.id, { status: "generating" });
        const cutout = await generateCutout(originalBlob);
        if (!cutout) {
          updateItem(look.id, { status: "skipped", error: "누끼 생성 실패 - 나중에 다시 시도 가능" });
          setProcessedCount((n) => n + 1);
          continue;
        }

        updateItem(look.id, { status: "uploading" });
        // 기존과 같은 Storage 경로(.../cutout, .../cutout-thumb)에 그대로
        // 업로드하므로 자동으로 덮어써진다. Firestore의 다른 필드(EXIF,
        // 날씨, createdAt, lookId 등)는 여기서 전혀 건드리지 않는다.
        const [detail, thumb] = await Promise.all([
          uploadLookCutout(user.uid, look.id, cutout.detailBlob),
          uploadLookCutoutThumbnail(user.uid, look.id, cutout.thumbBlob),
        ]);

        await updateLookCutoutFields(user.uid, look.id, {
          cutoutUrl: detail.cutoutUrl,
          cutoutStoragePath: detail.cutoutStoragePath,
          cutoutThumbnailUrl: thumb.cutoutThumbnailUrl,
          cutoutThumbnailStoragePath: thumb.cutoutThumbnailStoragePath,
          cutoutVersion: CURRENT_CUTOUT_VERSION,
        });

        updateItem(look.id, { status: "done" });
      } catch (err) {
        updateItem(look.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setProcessedCount((n) => n + 1);
      }
    }

    setRunning(false);
    setFinished(true);
    await refreshLooks();
  }

  const doneCount = items.filter((i) => i.status === "done").length;
  const skippedCount = items.filter((i) => i.status === "skipped").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  if (!ENABLE_CUTOUT_MIGRATION) {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
        <p className="text-sm text-neutral-400">
          이 도구는 현재 비활성화되어 있습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-10 sm:px-6">
      <header className="mb-6">
        <p className="text-xs font-medium tracking-wide text-amber-600">
          개발용 도구 — 기존 누끼 재생성
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          누끼 다시 생성
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          현재 알고리즘 버전 {CURRENT_CUTOUT_VERSION}보다 낮은(또는 아예 없는)
          룩 {pendingLooks.length}개를 원본 이미지로 다시 처리합니다. 사진이
          많으면 시간이 걸릴 수 있어요. 본인({user.email ?? user.uid})의
          룩만 대상입니다.
        </p>
      </header>

      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={running || pendingLooks.length === 0}
        className="w-full rounded-2xl bg-neutral-900 py-4 text-center text-sm font-medium text-white disabled:bg-neutral-300"
      >
        {running
          ? `${processedCount} / ${items.length} 진행중…`
          : pendingLooks.length === 0
          ? "재생성이 필요한 룩 없음"
          : `🔄 누끼 다시 생성 (${pendingLooks.length}개)`}
      </button>

      {finished && (
        <p className="mt-4 text-center text-sm font-medium text-neutral-700">
          완료 - 성공 {doneCount}장 · 건너뜀 {skippedCount}장 · 실패 {errorCount}장
        </p>
      )}

      {!finished && items.length > 0 && (
        <p className="mt-4 text-center text-xs text-neutral-500">
          {items.length}개 중 {processedCount}개 처리됨 (성공 {doneCount} · 건너뜀 {skippedCount} · 실패 {errorCount})
        </p>
      )}

      <ul className="mt-6 flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-xl border border-neutral-100 p-2"
          >
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-neutral-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
            </div>
            <div className="min-w-0 flex-1 text-xs">
              <p className="truncate text-neutral-400">{item.id}</p>
              <p
                className={
                  item.status === "error"
                    ? "text-red-600"
                    : item.status === "done"
                    ? "text-neutral-700"
                    : "text-neutral-400"
                }
              >
                {item.status === "pending" && "대기 중"}
                {item.status === "downloading" && "원본 다운로드 중…"}
                {item.status === "generating" && "누끼 생성 중…"}
                {item.status === "uploading" && "업로드 중…"}
                {item.status === "done" && "완료"}
                {item.status === "skipped" && `건너뜀 - ${item.error}`}
                {item.status === "error" && `실패 - ${item.error}`}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {/* 실수로 바로 실행되지 않도록, 버튼을 눌러도 곧바로 시작하지 않고
          한 번 더 확인한다. */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-sm rounded-t-3xl bg-white p-6 sm:rounded-3xl">
            <p className="text-base font-semibold text-neutral-900">
              누끼를 다시 생성할까요?
            </p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-500">
              기존 룩의 누끼 이미지를 최신 알고리즘으로 다시 생성합니다.
              원본 사진과 날짜·날씨 정보는 변경되지 않습니다.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium text-neutral-700"
              >
                취소
              </button>
              <button
                type="button"
                onClick={start}
                className="flex-1 rounded-2xl bg-neutral-900 py-3 text-sm font-medium text-white"
              >
                시작
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
