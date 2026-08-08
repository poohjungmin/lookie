"use client";

import { removeBackground } from "@imgly/background-removal";
import { downscaleImage } from "@/lib/downscaleImage";

// /dev/cutout-compare 비교 결과 @imgly/background-removal(AGPL-3.0, ISNet
// 기반)이 MediaPipe Selfie Segmenter보다 신발·머리카락·옷 경계 품질이
// 뚜렷이 좋아 채택. 리포지토리가 공개되어 있어 AGPL 조건상 실질적 리스크는 낮음.
const DETAIL_MAX_DIMENSION = 1000;
const THUMB_MAX_DIMENSION = 450;
const DETAIL_QUALITY = 0.9;
const THUMB_QUALITY = 0.75;
// 세그멘테이션 모델에 원본(12MP+)을 그대로 넣으면 iPhone Safari가 메모리
// 부족으로 탭을 강제 종료시키는 문제가 비교 단계에서 실측되었다 - 추론
// 전에 먼저 1024px로 줄인 사본을 사용한다 (상세 이미지 해상도의 실질적 상한).
const SEGMENT_INPUT_MAX_DIMENSION = 1024;

export type CutoutResult = {
  detailBlob: Blob;
  thumbBlob: Blob;
};

/** 알파(투명도)를 유지한 채로 리사이즈한다. WebP 인코딩이 안 되는 환경에서는 PNG로 폴백. */
async function resizeTransparent(
  source: Blob,
  maxDimension: number,
  quality: number
): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(source);
    try {
      const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      // 캔버스는 기본적으로 투명하다 - 배경을 채우지 않아야 누끼 알파가 유지된다.
      ctx.drawImage(bitmap, 0, 0, width, height);

      const webp = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/webp", quality);
      });
      if (webp && webp.type === "image/webp") return webp;

      // 구형 Safari는 image/webp 인코딩을 지원하지 않고 조용히 PNG나 null을
      // 반환한다 - PNG는 투명도를 항상 지원하므로 안전한 폴백이다.
      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/png");
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

async function runCutout(file: File | Blob): Promise<CutoutResult | null> {
  try {
    const segmentInput = await downscaleImage(file, SEGMENT_INPUT_MAX_DIMENSION, 0.9);
    const cutoutBlob = await removeBackground(segmentInput, {
      device: "cpu",
      output: { format: "image/png" },
    });

    const [detailBlob, thumbBlob] = await Promise.all([
      resizeTransparent(cutoutBlob, DETAIL_MAX_DIMENSION, DETAIL_QUALITY),
      resizeTransparent(cutoutBlob, THUMB_MAX_DIMENSION, THUMB_QUALITY),
    ]);

    if (!detailBlob || !thumbBlob) return null;
    return { detailBlob, thumbBlob };
  } catch {
    return null;
  }
}

// 여러 장을 한꺼번에 업로드/마이그레이션할 때도 누끼 추론만큼은 앱 전체에서
// 한 번에 하나씩만 돌게 직렬화한다. 메타데이터/날씨/원본 업로드는 여전히
// 사진별로 병렬 처리되지만, 무거운 세그멘테이션 모델을 여러 장 동시에
// 돌리면 iPhone Safari가 메모리 부족으로 탭을 강제 종료시키는 문제가
// /dev/cutout-compare에서 실측되었기 때문이다.
let cutoutQueue: Promise<unknown> = Promise.resolve();

/**
 * 원본 거울셀카에서 사람 전체(머리~신발)를 하나의 객체로 배경에서 분리해
 * 상세용/목록용 두 사이즈의 투명 이미지를 만든다.
 * 무거운 세그멘테이션 추론은 한 번만 실행하고, 두 사이즈는 그 결과를
 * 캔버스로 리사이즈만 하므로 빠르다.
 * 실패하면(모델 로드 실패, 메모리 부족 등) null - 호출부는 원본으로 폴백해야 한다.
 * 앱 전체에서 동시에 최대 1건만 실행되도록 직렬화되어 있다.
 */
export function generateCutout(file: File | Blob): Promise<CutoutResult | null> {
  const task = cutoutQueue.then(
    () => runCutout(file),
    () => runCutout(file)
  );
  // 이 작업이 실패해도 큐 자체는 계속 이어져야 다음 작업이 진행된다.
  cutoutQueue = task.catch(() => null);
  return task;
}
