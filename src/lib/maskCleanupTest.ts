"use client";

// /dev/mask-cleanup-test 전용 - production 누끼 파이프라인(cutout.ts)에는
// 어떤 영향도 주지 않는다. cutout.ts에서 이미 쓰고 있는 상수/함수를 그대로
// re-export 받아 "기존 방식(A)"을 한 글자도 다르지 않게 재현하고, 그 위에
// 새 cleanup 단계(B)만 추가로 검증한다. Firestore/Storage 쓰기 없음 -
// 전부 브라우저 메모리 안에서만 계산한다.
//
// cutout.ts가 실제로 하는 일(현재 구조의 핵심 결함):
// selectBodyComponent로 "사람 컴포넌트"를 고르긴 하지만, 그 이후 최종
// 이미지는 그 컴포넌트 주변의 bbox(+margin)를 그대로 원본 alpha에서
// 통째로 잘라 붙인다(drawImage) - 픽셀 단위로 다른 컴포넌트를 지우지
// 않는다. 그래서:
// - 난간이 사람과 "떨어진" 별도 컴포넌트여도, 그 bbox가 사람 bbox와
//   겹치거나 margin 안에 들어오면 그대로 살아남는다.
// - 난간이 손/팔과 alpha상 이어져 사람과 "같은" 컴포넌트가 되면(가장 흔한
//   케이스), 컴포넌트 전체의 bbox가 이미 난간 쪽으로 넓어져 있어서
//   THIN_ASPECT_RATIO 필터(컴포넌트 전체의 종횡비만 봄)로는 걸러지지
//   않는다 - 사람 몸통이 커서 전체 bbox 자체는 "가늘고 길다"고 판정되지
//   않기 때문.
// 이 파일의 cleanup은 두 가지를 새로 한다:
// 1) 선택된 컴포넌트에 실제로 속한 픽셀만 격리(다른 컴포넌트는 완전히
//    제거) - 이것만으로 "떨어진" 잔여물은 해결된다.
// 2) opening-by-reconstruction(침식으로 얇은 가지를 끊고, 살아남은
//    "몸통 core"만 원래 모양으로 되돌리는 재구성 팽창)으로, 사람과 같은
//    컴포넌트로 이어진 얇은 가지(난간/봉)를 추가로 제거한다. 몸통 자체는
//    침식 반경보다 두꺼우므로 core가 살아남고, 재구성 팽창이 원래 두께로
//    복원한다 - 그래서 팔/다리/몸통은 보존되고, 침식 반경보다 얇은 가지만
//    끊겨서 사라진다.

import {
  ALPHA_THRESHOLD,
  MORPH_CLOSE_RADIUS,
  CROP_PADDING_RATIO,
  NORMALIZE_CANVAS_WIDTH,
  NORMALIZE_CANVAS_HEIGHT,
  BODY_HEIGHT_RATIO,
  FOOT_BOTTOM_MARGIN_RATIO,
  COMPONENT_WINDOW_MARGIN_RATIO,
  buildBinaryMask,
  dilate,
  erode,
  morphologicalClose,
  selectBodyComponent,
  findAlphaBoundingBox,
  type BoundingBox,
  type Component,
} from "@/lib/cutout";

// 기존 컴포넌트 선택 단계(COMPONENT_ANALYSIS_MAX_DIM=256)보다 조금 더
// 정밀하게 - 그래도 원본 해상도보다는 훨씬 가볍게. 침식/재구성 연산이
// 이 해상도의 픽셀 수에 비례하므로, 너무 크면 느려지고 너무 작으면 손가락
// 같은 진짜 얇은 신체 부위까지 침식 한 번에 사라진다.
export const CLEANUP_ANALYSIS_MAX_DIM = 512;

// 이 반지름(픽셀, CLEANUP_ANALYSIS_MAX_DIM 좌표계 기준)의 지름(2*R)보다
// 얇은 가지를 잘라낸다. 512px 분석 해상도에서 2px 반경 = 지름 4px 미만
// 굵기의 가지만 제거 대상 - 난간/봉은 보통 이보다 얇게 보이고, 팔뚝/손목
// 같은 실제 신체는 이보다 두껍게 보이는 경우가 많다는 전제에서 보수적으로
// 시작한다. 사람이 잘리면 이 값을 줄이고, 잔여물이 안 지워지면 늘린다.
export const OPENING_EROSION_RADIUS = 2;

export type CleanupMetrics = {
  analysisWidth: number;
  analysisHeight: number;
  erosionRadiusUsed: number;
  originalBBoxPx: BoundingBox; // 선택된 컴포넌트만 격리한 마스크의 bbox (cleanup 전)
  cleanedBBoxPx: BoundingBox; // cleanup 후 bbox
  originalAreaPixels: number;
  removedPixels: number;
  removedAreaRatio: number; // removedPixels / originalAreaPixels
  bboxWidthShrinkRatio: number; // (original width - cleaned width) / original width
  bboxHeightShrinkRatio: number;
  timing: {
    /** 기존 파이프라인과 동일한 단계(마스크 생성~컴포넌트 선택)에 걸린 시간. */
    baselineMs: number;
    /** 이번에 추가된 cleanup(침식+재구성)에 걸린 시간. */
    cleanupMs: number;
  };
};

export type CleanupAnalysis = {
  bitmap: ImageBitmap;
  metrics: CleanupMetrics;
  /** 분석 해상도(analysisWidth x analysisHeight) 기준 0/1 마스크 - 선택된 컴포넌트만, cleanup 전. */
  isolatedMask: Uint8Array;
  /** 위 마스크에서 얇은 가지를 제거한 결과. */
  cleanedMask: Uint8Array;
};

function erodeN(mask: Uint8Array, width: number, height: number, n: number): Uint8Array {
  let m = mask;
  for (let i = 0; i < n; i++) m = erode(m, width, height);
  return m;
}

/** target 컴포넌트의 bbox 안에서 flood-fill로 그 컴포넌트에 실제로 속한 픽셀만 골라낸 마스크를 만든다. */
function isolateComponentMask(
  mask: Uint8Array,
  width: number,
  height: number,
  target: Component
): Uint8Array {
  const out = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);
  const stackX = new Int32Array(mask.length);
  const stackY = new Int32Array(mask.length);

  // target bbox 범위 안에서 mask=1인 첫 픽셀을 찾아 그 지점부터 flood-fill한다.
  // target은 findConnectedComponents가 실제로 찾아낸 컴포넌트이므로, 이
  // bbox 안에는 target에 속한 픽셀이 반드시 하나 이상 있다.
  let seedX = -1;
  let seedY = -1;
  for (let y = Math.max(0, target.minY); y <= Math.min(height - 1, target.maxY) && seedX < 0; y++) {
    for (let x = Math.max(0, target.minX); x <= Math.min(width - 1, target.maxX); x++) {
      if (mask[y * width + x]) {
        seedX = x;
        seedY = y;
        break;
      }
    }
  }
  if (seedX < 0) return out;

  let top = 0;
  stackX[top] = seedX;
  stackY[top] = seedY;
  top++;
  visited[seedY * width + seedX] = 1;

  while (top > 0) {
    top--;
    const cx = stackX[top];
    const cy = stackY[top];
    out[cy * width + cx] = 1;

    const left = cx - 1;
    const right = cx + 1;
    const up = cy - 1;
    const down = cy + 1;
    if (left >= 0) {
      const idx = cy * width + left;
      if (mask[idx] && !visited[idx]) {
        visited[idx] = 1;
        stackX[top] = left;
        stackY[top] = cy;
        top++;
      }
    }
    if (right < width) {
      const idx = cy * width + right;
      if (mask[idx] && !visited[idx]) {
        visited[idx] = 1;
        stackX[top] = right;
        stackY[top] = cy;
        top++;
      }
    }
    if (up >= 0) {
      const idx = up * width + cx;
      if (mask[idx] && !visited[idx]) {
        visited[idx] = 1;
        stackX[top] = cx;
        stackY[top] = up;
        top++;
      }
    }
    if (down < height) {
      const idx = down * width + cx;
      if (mask[idx] && !visited[idx]) {
        visited[idx] = 1;
        stackX[top] = cx;
        stackY[top] = down;
        top++;
      }
    }
  }

  return out;
}

/** 가장 큰(면적) 연결영역만 골라내는, isolateComponentMask와 짝을 이루는 헬퍼. */
function findLargestComponent(mask: Uint8Array, width: number, height: number): Component | null {
  const visited = new Uint8Array(mask.length);
  let best: Component | null = null;
  const stackX = new Int32Array(mask.length);
  const stackY = new Int32Array(mask.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!mask[idx] || visited[idx]) continue;

      let top = 0;
      stackX[top] = x;
      stackY[top] = y;
      top++;
      visited[idx] = 1;

      let area = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      while (top > 0) {
        top--;
        const cx = stackX[top];
        const cy = stackY[top];
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors: Array<[number, number]> = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (mask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stackX[top] = nx;
            stackY[top] = ny;
            top++;
          }
        }
      }

      if (!best || area > best.area) best = { area, minX, minY, maxX, maxY };
    }
  }

  return best;
}

/** 마커(core)를 limit 마스크 범위 안에서만 반복 팽창시켜 원래 모양으로 복원한다(geodesic dilation). */
function reconstructByDilation(
  marker: Uint8Array,
  limit: Uint8Array,
  width: number,
  height: number,
  maxIters: number
): Uint8Array {
  let m = marker;
  for (let i = 0; i < maxIters; i++) {
    const dilated = dilate(m, width, height);
    const next = new Uint8Array(dilated.length);
    let changed = false;
    for (let idx = 0; idx < next.length; idx++) {
      const v = dilated[idx] & limit[idx];
      next[idx] = v;
      if (v !== m[idx]) changed = true;
    }
    m = next;
    if (!changed) break;
  }
  return m;
}

function maskBoundingBox(mask: Uint8Array, width: number, height: number): BoundingBox | null {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * 배경 제거 결과(투명 PNG blob) 하나를 분석해 "기존 방식이 고른 사람
 * 컴포넌트만 격리한 마스크"와 "거기서 얇은 가지를 추가로 제거한 마스크"를
 * 함께 돌려준다. cutout.ts의 정규화 파이프라인과 완전히 같은 첫 단계
 * (마스크 생성 → closing → 컴포넌트 선택)를 거치므로, 여기서 나오는
 * "cleanup 전" 결과는 production이 실제로 고르는 컴포넌트와 동일하다.
 */
export async function analyzeAndCleanMask(
  cutoutBlob: Blob,
  options?: { analysisMaxDim?: number; erosionRadius?: number }
): Promise<CleanupAnalysis | null> {
  const analysisMaxDim = options?.analysisMaxDim ?? CLEANUP_ANALYSIS_MAX_DIM;
  const erosionRadius = options?.erosionRadius ?? OPENING_EROSION_RADIUS;

  const bitmap = await createImageBitmap(cutoutBlob);

  const t0 = performance.now();

  const analysisScale = Math.min(1, analysisMaxDim / Math.max(bitmap.width, bitmap.height));
  const analysisWidth = Math.max(1, Math.round(bitmap.width * analysisScale));
  const analysisHeight = Math.max(1, Math.round(bitmap.height * analysisScale));

  const canvas = document.createElement("canvas");
  canvas.width = analysisWidth;
  canvas.height = analysisHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, analysisWidth, analysisHeight);
  const imageData = ctx.getImageData(0, 0, analysisWidth, analysisHeight);

  // --- 기존 파이프라인과 동일한 단계 (cutout.ts와 같은 함수/상수 재사용) ---
  const binaryMask = buildBinaryMask(imageData, ALPHA_THRESHOLD);
  const closedMask = morphologicalClose(binaryMask, analysisWidth, analysisHeight, MORPH_CLOSE_RADIUS);
  // selectBodyComponent가 필요로 하는 Component[]를 얻기 위해, cutout.ts의
  // findConnectedComponents와 동일한 결과를 내는 별도 구현(라벨 포함 버전)을
  // 쓴다 - 이 파일에서 픽셀별 컴포넌트 소속(label)까지 필요하기 때문.
  const { components, labels } = labelConnectedComponents(closedMask, analysisWidth, analysisHeight);
  const bodyComponent = selectBodyComponent(components, analysisWidth, analysisHeight);
  if (!bodyComponent) {
    bitmap.close();
    return null;
  }
  const bodyLabel = components.indexOf(bodyComponent);

  const isolatedMask = new Uint8Array(closedMask.length);
  for (let i = 0; i < isolatedMask.length; i++) {
    isolatedMask[i] = labels[i] === bodyLabel ? 1 : 0;
  }
  const originalBBoxPx = maskBoundingBox(isolatedMask, analysisWidth, analysisHeight) ?? bodyComponent;
  const baselineMs = performance.now() - t0;

  // --- 추가 cleanup: opening by reconstruction ---
  const t1 = performance.now();
  const eroded = erodeN(isolatedMask, analysisWidth, analysisHeight, erosionRadius);
  const mainCore = findLargestComponent(eroded, analysisWidth, analysisHeight);

  let cleanedMask: Uint8Array;
  if (!mainCore) {
    // 침식 후 아무 것도 안 남으면(사람 자체가 매우 얇게 찍힌 극단적 케이스)
    // cleanup을 포기하고 원본을 그대로 쓴다 - 사람이 잘리는 것보다 잔여물이
    // 좀 남는 편이 낫다는 보수적 원칙.
    cleanedMask = isolatedMask;
  } else {
    const coreOnly = isolateComponentMask(eroded, analysisWidth, analysisHeight, mainCore);
    cleanedMask = reconstructByDilation(coreOnly, isolatedMask, analysisWidth, analysisHeight, erosionRadius + 2);
  }
  const cleanupMs = performance.now() - t1;

  const cleanedBBoxPx = maskBoundingBox(cleanedMask, analysisWidth, analysisHeight) ?? originalBBoxPx;

  let originalAreaPixels = 0;
  let removedPixels = 0;
  for (let i = 0; i < isolatedMask.length; i++) {
    if (isolatedMask[i]) {
      originalAreaPixels++;
      if (!cleanedMask[i]) removedPixels++;
    }
  }

  const originalWidth = originalBBoxPx.maxX - originalBBoxPx.minX + 1;
  const originalHeight = originalBBoxPx.maxY - originalBBoxPx.minY + 1;
  const cleanedWidth = cleanedBBoxPx.maxX - cleanedBBoxPx.minX + 1;
  const cleanedHeight = cleanedBBoxPx.maxY - cleanedBBoxPx.minY + 1;

  return {
    bitmap,
    isolatedMask,
    cleanedMask,
    metrics: {
      analysisWidth,
      analysisHeight,
      erosionRadiusUsed: erosionRadius,
      originalBBoxPx,
      cleanedBBoxPx,
      originalAreaPixels,
      removedPixels,
      removedAreaRatio: originalAreaPixels > 0 ? removedPixels / originalAreaPixels : 0,
      bboxWidthShrinkRatio: originalWidth > 0 ? (originalWidth - cleanedWidth) / originalWidth : 0,
      bboxHeightShrinkRatio: originalHeight > 0 ? (originalHeight - cleanedHeight) / originalHeight : 0,
      timing: { baselineMs, cleanupMs },
    },
  };
}

/** findConnectedComponents(cutout.ts)와 동일한 4-연결 flood-fill이지만, 픽셀별 컴포넌트 소속(label)도 함께 반환한다. */
function labelConnectedComponents(
  mask: Uint8Array,
  width: number,
  height: number
): { components: Component[]; labels: Int32Array } {
  const labels = new Int32Array(mask.length).fill(-1);
  const components: Component[] = [];
  const stackX = new Int32Array(mask.length);
  const stackY = new Int32Array(mask.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!mask[idx] || labels[idx] !== -1) continue;

      const label = components.length;
      let top = 0;
      stackX[top] = x;
      stackY[top] = y;
      top++;
      labels[idx] = label;

      let area = 0;
      let minX = x, maxX = x, minY = y, maxY = y;
      while (top > 0) {
        top--;
        const cx = stackX[top];
        const cy = stackY[top];
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const neighbors: Array<[number, number]> = [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (mask[nIdx] && labels[nIdx] === -1) {
            labels[nIdx] = label;
            stackX[top] = nx;
            stackY[top] = ny;
            top++;
          }
        }
      }

      components.push({ area, minX, minY, maxX, maxY });
    }
  }

  return { components, labels };
}

// --- 전체 해상도 이미지에 마스크를 적용해 실제 투명 누끼 preview를 만드는 유틸 ---

/**
 * 분석 해상도(analysisWidth x analysisHeight)의 0/1 마스크를 bitmap의 실제
 * 해상도로 최근접 보간(스무딩 없이) 확대한 뒤, 원본 alpha와 AND해서 최종
 * 투명 이미지를 만든다. cleanup은 저해상도에서만 계산하므로(성능), 실제
 * 출력에 적용할 때는 이렇게 원본 해상도로 다시 확대해야 한다.
 */
function applyMaskToFullRes(
  bitmap: ImageBitmap,
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number
): HTMLCanvasElement {
  // 1) 마스크를 작은 1bpp 이미지로 만들고
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskWidth;
  maskCanvas.height = maskHeight;
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) throw new Error("캔버스 컨텍스트 생성 실패");
  const maskImageData = maskCtx.createImageData(maskWidth, maskHeight);
  for (let i = 0; i < mask.length; i++) {
    maskImageData.data[i * 4 + 3] = mask[i] ? 255 : 0;
  }
  maskCtx.putImageData(maskImageData, 0, 0);

  // 2) 원본 해상도로 스무딩 없이 확대
  const upCanvas = document.createElement("canvas");
  upCanvas.width = bitmap.width;
  upCanvas.height = bitmap.height;
  const upCtx = upCanvas.getContext("2d");
  if (!upCtx) throw new Error("캔버스 컨텍스트 생성 실패");
  upCtx.imageSmoothingEnabled = false;
  upCtx.drawImage(maskCanvas, 0, 0, bitmap.width, bitmap.height);
  const upMask = upCtx.getImageData(0, 0, bitmap.width, bitmap.height);

  // 3) 원본을 그리고, alpha를 upMask와 AND
  const outCanvas = document.createElement("canvas");
  outCanvas.width = bitmap.width;
  outCanvas.height = bitmap.height;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) throw new Error("캔버스 컨텍스트 생성 실패");
  outCtx.drawImage(bitmap, 0, 0);
  const outData = outCtx.getImageData(0, 0, bitmap.width, bitmap.height);
  for (let i = 0; i < outData.data.length; i += 4) {
    if (upMask.data[i + 3] === 0) {
      outData.data[i + 3] = 0;
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

/**
 * cutout.ts normalizeCutout의 4~7단계(패딩 → 고정 캔버스 배치 → 발 하단
 * 정렬 → 스케일링)와 동일한 수식으로, 주어진 bbox(원본 픽셀 좌표) 기준
 * 결과를 2:3 정규화 캔버스에 그린다. A/B 두 결과 모두 이 함수 하나로
 * 그려서, 화면상 차이가 오직 마스크/bbox 차이에서만 나오게 한다(배치
 * 로직 차이로 인한 착시를 막기 위함).
 */
export function placeOnNormalizedCanvas(srcCanvas: HTMLCanvasElement, bboxSrcRes: BoundingBox): HTMLCanvasElement {
  const bboxWidth = bboxSrcRes.maxX - bboxSrcRes.minX + 1;
  const bboxHeight = bboxSrcRes.maxY - bboxSrcRes.minY + 1;
  const padX = bboxWidth * CROP_PADDING_RATIO;
  const padY = bboxHeight * CROP_PADDING_RATIO;

  const cropMinX = Math.max(0, bboxSrcRes.minX - padX);
  const cropMinY = Math.max(0, bboxSrcRes.minY - padY);
  const cropMaxX = Math.min(srcCanvas.width, bboxSrcRes.maxX + 1 + padX);
  const cropMaxY = Math.min(srcCanvas.height, bboxSrcRes.maxY + 1 + padY);
  const cropWidth = cropMaxX - cropMinX;
  const cropHeight = cropMaxY - cropMinY;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = NORMALIZE_CANVAS_WIDTH;
  outCanvas.height = NORMALIZE_CANVAS_HEIGHT;
  if (cropWidth <= 0 || cropHeight <= 0) return outCanvas;

  let scale = (NORMALIZE_CANVAS_HEIGHT * BODY_HEIGHT_RATIO) / bboxHeight;
  if (cropWidth * scale > NORMALIZE_CANVAS_WIDTH) {
    scale = NORMALIZE_CANVAS_WIDTH / cropWidth;
  }

  const destWidth = cropWidth * scale;
  const destHeight = cropHeight * scale;
  const destX = (NORMALIZE_CANVAS_WIDTH - destWidth) / 2;

  const footYInCrop = bboxSrcRes.maxY + 1 - cropMinY;
  const canvasFootY = NORMALIZE_CANVAS_HEIGHT * (1 - FOOT_BOTTOM_MARGIN_RATIO);
  const destY = canvasFootY - footYInCrop * scale;

  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) return outCanvas;
  outCtx.drawImage(srcCanvas, cropMinX, cropMinY, cropWidth, cropHeight, destX, destY, destWidth, destHeight);
  return outCanvas;
}

/** 분석 좌표계 bbox를 원본(bitmap) 좌표계로 확대 매핑한다 - cutout.ts 2단계와 동일한 계산. */
export function scaleBBoxToSource(bbox: BoundingBox, analysisWidth: number, sourceWidth: number): BoundingBox {
  const scaleBack = sourceWidth / analysisWidth;
  const w = bbox.maxX - bbox.minX + 1;
  const h = bbox.maxY - bbox.minY + 1;
  const marginX = w * scaleBack * COMPONENT_WINDOW_MARGIN_RATIO;
  const marginY = h * scaleBack * COMPONENT_WINDOW_MARGIN_RATIO;
  return {
    minX: bbox.minX * scaleBack - marginX,
    minY: bbox.minY * scaleBack - marginY,
    maxX: (bbox.maxX + 1) * scaleBack + marginX,
    maxY: (bbox.maxY + 1) * scaleBack + marginY,
  };
}

export { applyMaskToFullRes, findAlphaBoundingBox };
