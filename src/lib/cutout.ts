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
// 전에 먼저 1024px로 줄인 사본을 사용한다.
const SEGMENT_INPUT_MAX_DIMENSION = 1024;

// --- 사람 크기/위치 정규화 -------------------------------------------------
// 정규화는 이 내부 작업용 캔버스(2:3 세로 비율) 위에서 한 번 수행하고,
// 상세/썸네일은 이 결과를 그대로 리사이즈만 한다 - 그래서 두 사이즈의
// 사람 비율·정렬이 항상 똑같다.
const NORMALIZE_CANVAS_WIDTH = 1024;
const NORMALIZE_CANVAS_HEIGHT = 1536;
const BBOX_PADDING_RATIO = 0.08; // bounding box 상하좌우 8% 여백
const BODY_HEIGHT_RATIO = 0.86; // 머리~발이 캔버스 높이의 86%를 차지하도록 스케일
const FOOT_BOTTOM_MARGIN_RATIO = 0.05; // 발이 캔버스 하단에서 5% 위 고정 위치
const ALPHA_THRESHOLD = 10; // 이보다 낮은 알파는 노이즈로 보고 "사람"에서 제외

export type CutoutResult = {
  detailBlob: Blob;
  thumbBlob: Blob;
};

type BoundingBox = { minX: number; minY: number; maxX: number; maxY: number };

/** alpha가 threshold를 넘는 픽셀만으로 사람 영역의 bounding box를 계산한다. */
function findAlphaBoundingBox(imageData: ImageData): BoundingBox | null {
  const { data, width, height } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      const alpha = data[(rowOffset + x) * 4 + 3];
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * 누끼 결과를 사람 bounding box 기준으로 정규화한다:
 * 1) alpha>0 픽셀로 bounding box 계산
 * 2) 상하좌우 8% padding 추가
 * 3) 고정 캔버스(2:3 비율)에 다시 배치
 * 4) 발(bbox 하단)이 항상 캔버스 하단의 같은 위치에 오도록 정렬
 * 5) 가로 중앙 정렬
 * 6) 머리~발 길이가 캔버스 높이의 일정 비율을 차지하도록 스케일링
 *    → 같은 사람이 다른 거리/줌으로 찍혀도 화면상 크기가 비슷해 보인다.
 * bbox를 못 찾으면(완전 투명 등) null - 호출부는 정규화 없이 원본 누끼로 폴백한다.
 */
async function normalizeCutout(cutoutBlob: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(cutoutBlob);
    try {
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = bitmap.width;
      srcCanvas.height = bitmap.height;
      const srcCtx = srcCanvas.getContext("2d");
      if (!srcCtx) return null;
      srcCtx.drawImage(bitmap, 0, 0);

      const imageData = srcCtx.getImageData(0, 0, bitmap.width, bitmap.height);
      const bbox = findAlphaBoundingBox(imageData);
      if (!bbox) return null;

      const bboxWidth = bbox.maxX - bbox.minX + 1;
      const bboxHeight = bbox.maxY - bbox.minY + 1;
      const padX = bboxWidth * BBOX_PADDING_RATIO;
      const padY = bboxHeight * BBOX_PADDING_RATIO;

      const cropMinX = Math.max(0, bbox.minX - padX);
      const cropMinY = Math.max(0, bbox.minY - padY);
      const cropMaxX = Math.min(bitmap.width, bbox.maxX + 1 + padX);
      const cropMaxY = Math.min(bitmap.height, bbox.maxY + 1 + padY);
      const cropWidth = cropMaxX - cropMinX;
      const cropHeight = cropMaxY - cropMinY;
      if (cropWidth <= 0 || cropHeight <= 0) return null;

      // 머리~발(원본 bbox, padding 제외) 길이 기준으로 스케일을 정한다.
      // 사람이 캔버스보다 옆으로 넘치면 가로 기준으로 한 번 더 제한한다.
      let scale = (NORMALIZE_CANVAS_HEIGHT * BODY_HEIGHT_RATIO) / bboxHeight;
      if (cropWidth * scale > NORMALIZE_CANVAS_WIDTH) {
        scale = NORMALIZE_CANVAS_WIDTH / cropWidth;
      }

      const destWidth = cropWidth * scale;
      const destHeight = cropHeight * scale;
      const destX = (NORMALIZE_CANVAS_WIDTH - destWidth) / 2;

      // 발(bbox 하단)이 crop 좌표계에서 얼마나 아래에 있는지 구해서,
      // 캔버스 하단의 고정 위치에 오도록 세로 위치를 역산한다.
      const footYInCrop = bbox.maxY + 1 - cropMinY;
      const canvasFootY = NORMALIZE_CANVAS_HEIGHT * (1 - FOOT_BOTTOM_MARGIN_RATIO);
      const destY = canvasFootY - footYInCrop * scale;

      const outCanvas = document.createElement("canvas");
      outCanvas.width = NORMALIZE_CANVAS_WIDTH;
      outCanvas.height = NORMALIZE_CANVAS_HEIGHT;
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) return null;
      // 캔버스는 기본적으로 투명하다 - 배경을 채우지 않아야 누끼 알파가 유지된다.
      outCtx.drawImage(
        srcCanvas,
        cropMinX,
        cropMinY,
        cropWidth,
        cropHeight,
        destX,
        destY,
        destWidth,
        destHeight
      );

      return await new Promise<Blob | null>((resolve) => {
        outCanvas.toBlob((b) => resolve(b), "image/png");
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

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
    const rawCutout = await removeBackground(segmentInput, {
      device: "cpu",
      output: { format: "image/png" },
    });

    // 정규화에 실패해도(bbox를 못 찾는 등) 누끼 자체는 살려서, 사람 크기가
    // 제각각이더라도 최소한 배경은 제거된 상태로 저장되게 한다.
    const normalized = await normalizeCutout(rawCutout);
    const baseForResize = normalized ?? rawCutout;

    const [detailBlob, thumbBlob] = await Promise.all([
      resizeTransparent(baseForResize, DETAIL_MAX_DIMENSION, DETAIL_QUALITY),
      resizeTransparent(baseForResize, THUMB_MAX_DIMENSION, THUMB_QUALITY),
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
 * 원본 거울셀카에서 사람 전체(머리~신발)를 하나의 객체로 배경에서 분리하고
 * bounding box 기준으로 크기/위치를 정규화해, 상세용/목록용 두 사이즈의
 * 투명 이미지를 만든다. 무거운 세그멘테이션 추론은 한 번만 실행하고, 두
 * 사이즈는 정규화된 결과를 캔버스로 리사이즈만 하므로 빠르다.
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
