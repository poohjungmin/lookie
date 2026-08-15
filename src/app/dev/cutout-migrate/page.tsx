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
 * DEVELOPMENT ONLY — Storage에 남아있는 original 이미지로 cutout/cutout-thumb를
 * 최신 정규화 알고리즘으로 다시 만들어 덮어쓰는 일괄 재처리 도구.
 * cutoutVersion이 CURRENT_CUTOUT_VERSION보다 낮은(또는 아예 없는) 룩만
 * 대상으로 삼고, 이미 최신인 룩은 건너뛴다.
 *
 * 절대 건드리지 않는 것: Firestore 문서 삭제, lookId, createdAt, 날씨,
 * EXIF(위경도/촬영일) - 오직 Storage의 cutout/cutout-thumb 파일과 Firestore의
 * cutoutUrl/cutoutThumbnailUrl/(관련 storagePath)/cutoutVersion/updatedAt만 바뀐다.
 *
 * 다 쓰고 나면 이 라우트(src/app/dev/cutout-migrate) 전체를 삭제하면 된다 -
 * 다른 코드는 이 페이지를 참조하지 않는다.
 *
 * 한 번에 전부 Promise.all로 돌리지 않고 for...of로 한 장씩 순차 처리한다
 * (generateCutout 자체도 앱 전체에서 직렬화되어 있지만, 원본 다운로드 등
 * 다른 단계까지 겹치지 않도록 여기서도 한 번에 한 장만 진행한다) -
 * 사진이 많아도(수백~수천 장) iPhone 메모리 사용량이 폭증하지 않게 하기 위함.
 */

const isDev = process.env.NODE_ENV !== "production";

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

  const pendingLooks = looks.filter((l) => (l.cutoutVersion ?? 0) < CURRENT_CUTOUT_VERSION);

  function updateItem(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function start() {
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
  const failCount = items.filter((i) => i.status === "error" || i.status === "skipped").length;

  if (!isDev) {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
        <p className="text-sm text-neutral-400">
          이 기능은 개발 모드에서만 사용할 수 있습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-10 sm:px-6">
      <header className="mb-6">
        <p className="text-xs font-medium tracking-wide text-neutral-400">
          DEV ONLY
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          누끼 다시 생성
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          현재 알고리즘 버전 {CURRENT_CUTOUT_VERSION}보다 낮은(또는 아예 없는)
          룩 {pendingLooks.length}개를 원본 이미지로 다시 처리합니다. 사진이
          많으면 시간이 걸릴 수 있어요.
        </p>
      </header>

      <button
        type="button"
        onClick={start}
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
          완료 - 성공 {doneCount}장 · 실패 {failCount}장
        </p>
      )}

      {!finished && items.length > 0 && (
        <p className="mt-4 text-center text-xs text-neutral-500">
          {items.length}개 중 {processedCount}개 처리됨 (완료 {doneCount} · 실패/건너뜀 {failCount})
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
