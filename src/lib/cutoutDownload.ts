"use client";

import { downloadLookOriginal } from "@/lib/lookStore";
import { withTimeout } from "@/lib/timeout";

const DOWNLOAD_TIMEOUT_MS = 20000;

type DownloadAttempt = { ok: true; blob: Blob; ms: number } | { ok: false; err: unknown };

function describeErrorShort(err: unknown): string {
  const e = err as { name?: string; message?: string };
  return `${e?.name ?? "Error"}: ${e?.message ?? String(err)}`;
}

/**
 * 일부 환경(광고/추적 차단기, 또는 Storage 버킷 CORS 미설정)에서는
 * fetch()/XHR류 요청만 막히고 <img> 리소스 로딩은 통과되는 경우가 실측
 * 확인되었다. crossOrigin="anonymous"로 이미지를 로드한 뒤 캔버스에 그려서
 * Blob으로 재구성한다 (서버가 Access-Control-Allow-Origin을 보내야
 * 캔버스 판독이 오염되지 않는다 - Storage 버킷에 CORS 설정이 필요).
 */
function loadImageAsBlob(url: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("캔버스 컨텍스트 생성 실패"));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("캔버스 → Blob 변환 실패 (이미지가 CORS로 오염됐을 수 있음)"));
        }, "image/jpeg", 0.95);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    img.onerror = () => reject(new Error("이미지 로드 실패 (img onerror)"));
    img.src = url;
  });
}

/**
 * 원본을 세 가지 방식으로 동시에 시도한다: SDK getBlob(), 공개 URL fetch(),
 * <img crossOrigin> + 캔버스. 어느 하나라도 성공하면 그 결과를 쓰고,
 * 셋 다 실패하면 세 결과를 전부 담아 던진다.
 */
export async function downloadOriginalWithFallbacks(
  uid: string,
  lookId: string,
  storagePath: string | null,
  imageUrl: string
): Promise<{ blob: Blob; source: string; notes: string[] }> {
  const sdkStarted = performance.now();
  const sdkAttempt: Promise<DownloadAttempt> = withTimeout(
    downloadLookOriginal(uid, lookId, storagePath),
    DOWNLOAD_TIMEOUT_MS,
    "SDK getBlob"
  ).then(
    (blob) => ({ ok: true as const, blob, ms: Math.round(performance.now() - sdkStarted) }),
    (err) => ({ ok: false as const, err })
  );

  const fetchStarted = performance.now();
  const fetchAttempt: Promise<DownloadAttempt> = (async () => {
    if (!imageUrl) return { ok: false as const, err: new Error("imageUrl 없음") };
    try {
      const res = await withTimeout(fetch(imageUrl), DOWNLOAD_TIMEOUT_MS, "공개 URL fetch");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      return { ok: true as const, blob, ms: Math.round(performance.now() - fetchStarted) };
    } catch (err) {
      return { ok: false as const, err };
    }
  })();

  const imgStarted = performance.now();
  const imgAttempt: Promise<DownloadAttempt> = (async () => {
    if (!imageUrl) return { ok: false as const, err: new Error("imageUrl 없음") };
    try {
      const blob = await withTimeout(loadImageAsBlob(imageUrl), DOWNLOAD_TIMEOUT_MS, "img 태그 로드");
      return { ok: true as const, blob, ms: Math.round(performance.now() - imgStarted) };
    } catch (err) {
      return { ok: false as const, err };
    }
  })();

  const [sdkResult, fetchResult, imgResult] = await Promise.all([sdkAttempt, fetchAttempt, imgAttempt]);

  const noteOf = (label: string, r: DownloadAttempt) =>
    r.ok ? `${label}: 성공 (${r.ms}ms)` : `${label}: 실패 - ${describeErrorShort(r.err)}`;
  const notes = [
    noteOf("SDK getBlob", sdkResult),
    noteOf("공개 URL fetch", fetchResult),
    noteOf("img 태그+캔버스", imgResult),
  ];

  if (sdkResult.ok) return { blob: sdkResult.blob, source: "SDK getBlob", notes };
  if (fetchResult.ok) return { blob: fetchResult.blob, source: "공개 URL fetch", notes };
  if (imgResult.ok) return { blob: imgResult.blob, source: "img 태그+캔버스", notes };

  const combined = new Error(`원본 다운로드 3가지 방식 모두 실패:\n${notes.join("\n")}`);
  combined.name = "AllDownloadMethodsFailed";
  throw combined;
}
