"use client";

import { removeBackground } from "@imgly/background-removal";

export type CutoutRunResult =
  | { ok: true; blob: Blob; ms: number }
  | { ok: false; error: string; ms: number };

/**
 * DEVELOPMENT ONLY (비교 페이지 전용) — @imgly/background-removal(AGPL-3.0,
 * ISNet 기반)로 배경을 제거한다. 실제 서비스에 채택할지는 비교 후 결정.
 */
export async function runImgly(file: Blob): Promise<CutoutRunResult> {
  const started = performance.now();
  try {
    const blob = await removeBackground(file, {
      device: "cpu",
      output: { format: "image/png" },
    });
    return { ok: true, blob, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Math.round(performance.now() - started),
    };
  }
}
