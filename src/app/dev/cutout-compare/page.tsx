"use client";

import { useState } from "react";
import { runImgly } from "@/lib/cutoutImgly";
import { runMediapipe } from "@/lib/cutoutMediapipe";
import { downscaleImage } from "@/lib/downscaleImage";

/*
 * DEVELOPMENT ONLY — 전신 누끼 방식 두 가지(MediaPipe vs @imgly/background-removal)를
 * 같은 사진으로 실행해 신발/머리카락/옷 경계/속도/용량을 눈으로 비교하기 위한
 * 임시 페이지. 최종 방식이 정해지면 이 라우트(src/app/dev/cutout-compare)
 * 전체를 삭제하면 된다 - 다른 코드는 이 페이지를 참조하지 않는다.
 */

const MAX_FILES = 10;

type MethodState = {
  status: "pending" | "running" | "done" | "error";
  url?: string;
  ms?: number;
  bytes?: number;
  error?: string;
};

type Row = {
  id: string;
  file: File;
  previewUrl: string;
  mediapipe: MethodState;
  imgly: MethodState;
};

function formatKb(bytes?: number): string {
  if (bytes === undefined) return "-";
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function MethodCell({ label, state }: { label: string; state: MethodState }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-medium text-neutral-500">{label}</p>
      <div className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl bg-neutral-100">
        {state.status === "pending" && (
          <span className="text-[11px] text-neutral-300">대기 중</span>
        )}
        {state.status === "running" && (
          <span className="text-[11px] text-neutral-400">처리 중…</span>
        )}
        {state.status === "error" && (
          <span className="px-2 text-center text-[10px] text-red-500">
            실패: {state.error}
          </span>
        )}
        {state.status === "done" && state.url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={state.url} alt="" className="h-full w-full object-contain" />
        )}
      </div>
      {state.status === "done" && (
        <p className="text-[10px] text-neutral-400">
          {state.ms}ms · {formatKb(state.bytes)}
        </p>
      )}
    </div>
  );
}

export default function CutoutComparePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [processing, setProcessing] = useState(false);

  function updateMethod(id: string, method: "mediapipe" | "imgly", patch: Partial<MethodState>) {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id ? { ...r, [method]: { ...r[method], ...patch } } : r
      )
    );
  }

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || processing) return;
    const files = Array.from(fileList).slice(0, MAX_FILES);

    const initial: Row[] = files.map((file) => ({
      id: `${file.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: URL.createObjectURL(file),
      mediapipe: { status: "pending" },
      imgly: { status: "pending" },
    }));

    setRows(initial);
    setProcessing(true);

    // iPhone 메모리 문제를 피하기 위해 사진 한 장씩, 방식도 하나씩
    // 순차적으로 처리한다 (병렬 실행 금지). 원본을 그대로(수 MB, 12MP+)
    // 두 WASM 모델에 먹이면 캔버스 픽셀 버퍼 + 모델 텐서 메모리가 겹쳐서
    // iOS Safari가 탭을 강제 종료시키는 문제가 있어, 먼저 1024px로 줄인
    // 사본을 두 방식 모두에 공통으로 사용한다 (비교 조건도 동일해짐).
    for (const row of initial) {
      try {
        const resized = await downscaleImage(row.file, 1024, 0.85);

        updateMethod(row.id, "mediapipe", { status: "running" });
        const mp = await runMediapipe(resized);
        if (mp.ok) {
          updateMethod(row.id, "mediapipe", {
            status: "done",
            url: URL.createObjectURL(mp.blob),
            ms: mp.ms,
            bytes: mp.blob.size,
          });
        } else {
          updateMethod(row.id, "mediapipe", { status: "error", error: mp.error, ms: mp.ms });
        }

        updateMethod(row.id, "imgly", { status: "running" });
        const im = await runImgly(resized);
        if (im.ok) {
          updateMethod(row.id, "imgly", {
            status: "done",
            url: URL.createObjectURL(im.blob),
            ms: im.ms,
            bytes: im.blob.size,
          });
        } else {
          updateMethod(row.id, "imgly", { status: "error", error: im.error, ms: im.ms });
        }
      } catch (err) {
        // 이 사진에서 무슨 일이 나든 다음 사진 처리는 계속되어야 한다.
        const message = err instanceof Error ? err.message : String(err);
        updateMethod(row.id, "mediapipe", { status: "error", error: message });
        updateMethod(row.id, "imgly", { status: "error", error: message });
      }
    }

    setProcessing(false);
  }

  const doneRows = rows.filter((r) => r.mediapipe.status === "done" && r.imgly.status === "done");
  const avg = (nums: number[]) => (nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0);
  const mpAvgMs = avg(doneRows.map((r) => r.mediapipe.ms ?? 0));
  const imAvgMs = avg(doneRows.map((r) => r.imgly.ms ?? 0));
  const mpAvgKb = avg(doneRows.map((r) => (r.mediapipe.bytes ?? 0) / 1024));
  const imAvgKb = avg(doneRows.map((r) => (r.imgly.bytes ?? 0) / 1024));

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-10 sm:px-6">
      <header className="mb-6">
        <p className="text-xs font-medium tracking-wide text-neutral-400">
          DEV ONLY
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          누끼 방식 비교
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          같은 거울셀카 최대 10장으로 MediaPipe vs @imgly/background-removal을
          비교합니다. 신발·머리카락·옷 경계를 눈으로, 속도·용량은 숫자로
          확인하세요. 사진 1장씩, 방식 1개씩 순차 처리합니다.
        </p>
      </header>

      <label
        className={
          "relative z-10 block w-full rounded-2xl py-4 text-center text-sm font-medium text-white " +
          (processing
            ? "bg-neutral-300"
            : "cursor-pointer select-none bg-neutral-900 active:bg-neutral-700")
        }
      >
        {processing ? "처리 중…" : "비교할 사진 선택하기 (최대 10장)"}
        <input
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          disabled={processing}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>

      {doneRows.length > 0 && (
        <div className="mt-6 rounded-2xl bg-neutral-50 p-4 text-xs text-neutral-600">
          <p className="font-medium text-neutral-700">
            평균 ({doneRows.length}장 완료 기준)
          </p>
          <p className="mt-1">MediaPipe: {mpAvgMs}ms · {mpAvgKb}KB</p>
          <p>@imgly/background-removal: {imAvgMs}ms · {imAvgKb}KB</p>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-6">
        {rows.map((row) => (
          <div key={row.id} className="rounded-2xl border border-neutral-100 p-3">
            <p className="mb-2 truncate text-[11px] text-neutral-400">
              {row.file.name}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <p className="text-[11px] font-medium text-neutral-500">원본</p>
                <div className="aspect-[3/4] overflow-hidden rounded-xl bg-neutral-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={row.previewUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </div>
              </div>
              <MethodCell label="MediaPipe" state={row.mediapipe} />
              <MethodCell label="@imgly" state={row.imgly} />
            </div>
          </div>
        ))}
      </div>

      {rows.length === 0 && (
        <p className="mt-10 text-center text-xs text-neutral-300">
          아직 선택한 사진이 없습니다
        </p>
      )}
    </div>
  );
}
