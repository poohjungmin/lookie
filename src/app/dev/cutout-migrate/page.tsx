"use client";

import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import { generateCutout } from "@/lib/cutout";
import {
  uploadLookCutout,
  uploadLookCutoutThumbnail,
  updateLookCutoutFields,
} from "@/lib/lookStore";

/*
 * DEVELOPMENT ONLY — 누끼 필드가 추가되기 전에 이미 저장된 기존 룩들에
 * 일괄로 누끼(cutoutUrl/cutoutThumbnailUrl)를 만들어 채워 넣는 임시 도구.
 * 다 쓰고 나면 이 라우트(src/app/dev/cutout-migrate) 전체를 삭제하면 된다 -
 * 다른 코드는 이 페이지를 참조하지 않는다.
 *
 * 한 장씩 순차 처리한다 (generateCutout 자체도 앱 전체에서 직렬화되어
 * 있지만, 원본 다운로드 등 다른 단계까지 겹치지 않도록 여기서도 한
 * 번에 한 장만 진행한다) - iPhone 메모리 문제를 피하기 위함.
 */

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

  const pendingLooks = looks.filter((l) => !l.cutoutUrl);

  function updateItem(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function start() {
    if (running) return;
    const targets = pendingLooks;
    if (targets.length === 0) return;

    setItems(
      targets.map((look) => ({ id: look.id, imageUrl: look.imageUrl, status: "pending" }))
    );
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
          continue;
        }

        updateItem(look.id, { status: "uploading" });
        const [detail, thumb] = await Promise.all([
          uploadLookCutout(user.uid, look.id, cutout.detailBlob),
          uploadLookCutoutThumbnail(user.uid, look.id, cutout.thumbBlob),
        ]);

        await updateLookCutoutFields(user.uid, look.id, {
          cutoutUrl: detail.cutoutUrl,
          cutoutStoragePath: detail.cutoutStoragePath,
          cutoutThumbnailUrl: thumb.cutoutThumbnailUrl,
          cutoutThumbnailStoragePath: thumb.cutoutThumbnailStoragePath,
        });

        updateItem(look.id, { status: "done" });
      } catch (err) {
        updateItem(look.id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    setRunning(false);
    await refreshLooks();
  }

  const doneCount = items.filter((i) => i.status === "done").length;
  const errorCount = items.filter((i) => i.status === "error" || i.status === "skipped").length;

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-10 sm:px-6">
      <header className="mb-6">
        <p className="text-xs font-medium tracking-wide text-neutral-400">
          DEV ONLY
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          기존 룩 누끼 생성
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          누끼가 없는 룩 {pendingLooks.length}개를 순차적으로(한 번에 한 장씩)
          처리합니다. 사진이 많으면 시간이 걸릴 수 있어요.
        </p>
      </header>

      <button
        type="button"
        onClick={start}
        disabled={running || pendingLooks.length === 0}
        className="w-full rounded-2xl bg-neutral-900 py-4 text-center text-sm font-medium text-white disabled:bg-neutral-300"
      >
        {running
          ? "처리 중…"
          : pendingLooks.length === 0
          ? "누끼 없는 룩 없음"
          : `${pendingLooks.length}개 누끼 생성 시작`}
      </button>

      {items.length > 0 && (
        <p className="mt-4 text-center text-xs text-neutral-500">
          {items.length}개 중 완료 {doneCount} · 실패/건너뜀 {errorCount}
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
    </div>
  );
}
