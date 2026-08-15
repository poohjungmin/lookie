"use client";

import { removeBackground } from "@imgly/background-removal";
import { downscaleImage } from "@/lib/downscaleImage";
import {
  computePersonalizedAutoCropWithDiagnostics,
  isAutoResultSuspicious,
  logPersonalCropDecision,
  type CropRatioBox,
  type ManualCropCorrectionRecord,
  type PersonalizationDiagnostics,
} from "@/lib/cropCorrectionMath";

// 이 함수는 여러 곳(자동 업로드/재업로드, /dev/cutout-migrate)에서 사진마다
// 반복 호출되므로, 디버그 로그를 위한 추가 연산(개인화 기록이 0개일 때도
// suspicious를 계산하는 것 등)은 개발 환경에서만 켠다 - production 처리
// 속도/사용자 경험에는 전혀 영향이 없다.
const isPersonalCropDebugEnabled = process.env.NODE_ENV !== "production";

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
export const SEGMENT_INPUT_MAX_DIMENSION = 1024;

// 이 번호를 올리면 /dev/cutout-migrate가 "재생성 필요"로 판단한다.
// 기존에 저장된 누끼(또는 cutoutVersion이 아예 없는 룩)는 이 값보다
// 낮은 것으로 취급된다.
// v3: 얇고 긴 배경 잔여물(엘리베이터 손잡이/난간/거울 프레임 등) 제거
// cleanup을 추가 - /dev/mask-cleanup-test에서 검증 후 적용.
export const CURRENT_CUTOUT_VERSION = 3;

// --- 사람 크기/위치 정규화 -------------------------------------------------
// 정규화는 이 내부 작업용 캔버스(2:3 세로 비율) 위에서 한 번 수행하고,
// 상세/썸네일은 이 결과를 그대로 리사이즈만 한다 - 그래서 두 사이즈의
// 사람 비율·정렬이 항상 똑같다.
// export: /dev/mask-cleanup-test가 "기존 방식"을 완전히 동일하게 재현하기
// 위해 그대로 재사용한다 (읽기 전용 재사용 - 이 export 추가 자체는 아래
// 로직/값을 전혀 바꾸지 않는다).
export const NORMALIZE_CANVAS_WIDTH = 1024;
export const NORMALIZE_CANVAS_HEIGHT = 1536;
export const CROP_PADDING_RATIO = 0.04; // bounding box 상하좌우 4% 여백 (최소화)
export const BODY_HEIGHT_RATIO = 0.95; // 머리~발이 캔버스 높이의 95%를 차지하도록 스케일
export const FOOT_BOTTOM_MARGIN_RATIO = 0.025; // 발이 캔버스 하단에서 2.5% 위 고정 위치
export const ALPHA_THRESHOLD = 10; // 이보다 낮은 알파는 노이즈로 보고 "사람"에서 제외

// person 컴포넌트를 고를 때 쓰는, 저해상도 연결영역 분석용 설정.
// 다운샘플로 충분히 빠르면서도 거울 난간/스트랩 같은 가늘고 긴 잔여물과
// 사람 본체를 구분할 수 있는 해상도. /dev/mask-cleanup-test에서 256px는
// 얇은 가지 cleanup(아래 OPENING_EROSION_RADIUS)에 비해 해상도가 부족해
// 512px로 올렸다 - MIN_COMPONENT_AREA_RATIO/THIN_ASPECT_RATIO는 절대
// 픽셀이 아니라 비율 기준이라 해상도를 올려도 재조정이 필요 없다.
export const COMPONENT_ANALYSIS_MAX_DIM = 512;
export const MIN_COMPONENT_AREA_RATIO = 0.005; // 분석 캔버스 전체 픽셀의 0.5% 미만은 잡음으로 간주
export const THIN_ASPECT_RATIO = 0.12; // min(w,h)/max(w,h)가 이보다 작으면 "가늘고 긴" 형태(난간 등)로 간주
export const MORPH_CLOSE_RADIUS = 1; // 아주 약한 closing(팽창→침식) - 손/팔 사이 작은 틈을 이어붙임
// 저해상도에서 찾은 사람 컴포넌트를 원본 해상도로 확대할 때, 다운샘플링으로
// 잘려나갔을 수 있는 경계(머리카락 끝, 손끝 등)를 보정하기 위한 여유분.
export const COMPONENT_WINDOW_MARGIN_RATIO = 0.06;
// 이 반지름(분석 해상도 픽셀 기준)의 지름(2*R)보다 얇게 사람 본체와 이어진
// 가지(엘리베이터 손잡이/난간 등)를 잘라낸다. /dev/mask-cleanup-test에서
// 여러 샘플로 검증한 값 - 팔/다리/긴소매/가방끈처럼 이보다 두꺼운 부위는
// opening-by-reconstruction(아래)이 원래 두께로 복원한다.
export const OPENING_EROSION_RADIUS = 2;

/** 자동으로 검출된 사람 bbox(원본 대비 0~1 비율, personalization 보정 "전" 값)와
 * 이번 실행에서 개인화 보정이 실제로 적용됐는지. manualCropCorrection 기록을
 * 남길 때 "자동으로 잡혔던 영역" 비교 기준으로 쓴다. */
export type AutoCropInfo = {
  bboxRatio: CropRatioBox;
  personalizationApplied: boolean;
};

export type CutoutResult = {
  detailBlob: Blob;
  thumbBlob: Blob;
  /** 정규화가 사람을 못 찾아 실패했으면 null. */
  autoCrop: AutoCropInfo | null;
};

export type BoundingBox = { minX: number; minY: number; maxX: number; maxY: number };
export type Component = BoundingBox & { area: number };

/** alpha가 threshold를 넘는 픽셀만으로 bounding box를 계산한다 (특정 영역으로 한정 가능). */
export function findAlphaBoundingBox(
  imageData: ImageData,
  region?: BoundingBox
): BoundingBox | null {
  const { data, width, height } = imageData;
  const startX = region ? Math.max(0, Math.floor(region.minX)) : 0;
  const startY = region ? Math.max(0, Math.floor(region.minY)) : 0;
  const endX = region ? Math.min(width - 1, Math.ceil(region.maxX)) : width - 1;
  const endY = region ? Math.min(height - 1, Math.ceil(region.maxY)) : height - 1;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = startY; y <= endY; y++) {
    const rowOffset = y * width;
    for (let x = startX; x <= endX; x++) {
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

export function buildBinaryMask(imageData: ImageData, threshold: number): Uint8Array {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = data[i * 4 + 3] > threshold ? 1 : 0;
  }
  return mask;
}

export function dilate(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) {
        for (let dx = -1; dx <= 1 && !v; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx]) v = 1;
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

export function erode(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 1;
      for (let dy = -1; dy <= 1 && v; dy++) {
        for (let dx = -1; dx <= 1 && v; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny * width + nx]) v = 0;
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/** 아주 약한 closing(팽창 후 침식) - 사람 몸 안의 작은 틈을 이어붙여 하나의 덩어리로 만든다. */
export function morphologicalClose(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  let m = mask;
  for (let i = 0; i < radius; i++) m = dilate(m, width, height);
  for (let i = 0; i < radius; i++) m = erode(m, width, height);
  return m;
}

/**
 * 4방향 연결 기준으로 이진 마스크의 연결영역(component)들을 모두 찾고,
 * 픽셀별로 어느 컴포넌트에 속하는지(label)도 함께 반환한다. label은
 * components 배열의 인덱스와 같다 - "선택된 컴포넌트에 실제로 속한
 * 픽셀만" 골라내는 cleanup 단계(isolateComponentMask)에 필요하다.
 */
function findConnectedComponentsLabeled(
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
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      while (top > 0) {
        top--;
        const cx = stackX[top];
        const cy = stackY[top];
        area++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        const left = cx - 1;
        const right = cx + 1;
        const up = cy - 1;
        const down = cy + 1;

        if (left >= 0) {
          const nIdx = cy * width + left;
          if (mask[nIdx] && labels[nIdx] === -1) {
            labels[nIdx] = label;
            stackX[top] = left;
            stackY[top] = cy;
            top++;
          }
        }
        if (right < width) {
          const nIdx = cy * width + right;
          if (mask[nIdx] && labels[nIdx] === -1) {
            labels[nIdx] = label;
            stackX[top] = right;
            stackY[top] = cy;
            top++;
          }
        }
        if (up >= 0) {
          const nIdx = up * width + cx;
          if (mask[nIdx] && labels[nIdx] === -1) {
            labels[nIdx] = label;
            stackX[top] = cx;
            stackY[top] = up;
            top++;
          }
        }
        if (down < height) {
          const nIdx = down * width + cx;
          if (mask[nIdx] && labels[nIdx] === -1) {
            labels[nIdx] = label;
            stackX[top] = cx;
            stackY[top] = down;
            top++;
          }
        }
      }

      components.push({ area, minX, minY, maxX, maxY });
    }
  }

  return { components, labels };
}

/** 4방향 연결 기준으로 이진 마스크의 연결영역(component)들을 모두 찾는다. */
export function findConnectedComponents(mask: Uint8Array, width: number, height: number): Component[] {
  return findConnectedComponentsLabeled(mask, width, height).components;
}

/** target 컴포넌트의 bbox 안에서 flood-fill로 그 컴포넌트에 실제로 속한 픽셀만 골라낸 마스크를 만든다. */
function isolateComponentMask(mask: Uint8Array, width: number, height: number, target: Component): Uint8Array {
  const out = new Uint8Array(mask.length);
  const visited = new Uint8Array(mask.length);
  const stackX = new Int32Array(mask.length);
  const stackY = new Int32Array(mask.length);

  // target bbox 범위 안에서 mask=1인 첫 픽셀부터 flood-fill한다 - target은
  // findConnectedComponents(Labeled)가 실제로 찾아낸 컴포넌트이므로, 이
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

function erodeN(mask: Uint8Array, width: number, height: number, n: number): Uint8Array {
  let m = mask;
  for (let i = 0; i < n; i++) m = erode(m, width, height);
  return m;
}

function findLargestComponent(mask: Uint8Array, width: number, height: number): Component | null {
  const { components } = findConnectedComponentsLabeled(mask, width, height);
  if (components.length === 0) return null;
  return components.reduce((a, b) => (b.area > a.area ? b : a));
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

function maskBoundingBoxLowRes(mask: Uint8Array, width: number, height: number): BoundingBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
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
 * 저해상도(analysis) 0/1 마스크를 bitmap의 실제 해상도로 최근접 보간(스무딩
 * 없이) 확대한 뒤, 원본 alpha와 AND해서 배경 잔여물을 실제 픽셀에서 지운다.
 * 기존 파이프라인은 컴포넌트 분석 결과를 "어디를 crop할지" 정하는 데만
 * 쓰고 원본 alpha를 그대로 복사해 왔는데, 그게 바로 crop 영역 안에 든
 * 잔여물(철봉 등)이 계속 살아남던 원인이었다 - 이제는 실제로 지운다.
 */
function applyLowResMaskToFullRes(
  bitmap: ImageBitmap,
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number
): HTMLCanvasElement | null {
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = maskWidth;
  maskCanvas.height = maskHeight;
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) return null;
  const maskImageData = maskCtx.createImageData(maskWidth, maskHeight);
  for (let i = 0; i < mask.length; i++) {
    maskImageData.data[i * 4 + 3] = mask[i] ? 255 : 0;
  }
  maskCtx.putImageData(maskImageData, 0, 0);

  const upCanvas = document.createElement("canvas");
  upCanvas.width = bitmap.width;
  upCanvas.height = bitmap.height;
  const upCtx = upCanvas.getContext("2d");
  if (!upCtx) return null;
  upCtx.imageSmoothingEnabled = false;
  upCtx.drawImage(maskCanvas, 0, 0, bitmap.width, bitmap.height);
  const upMask = upCtx.getImageData(0, 0, bitmap.width, bitmap.height);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = bitmap.width;
  outCanvas.height = bitmap.height;
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) return null;
  outCtx.drawImage(bitmap, 0, 0);
  const outData = outCtx.getImageData(0, 0, bitmap.width, bitmap.height);
  for (let i = 0; i < outData.data.length; i += 4) {
    if (upMask.data[i + 3] === 0) outData.data[i + 3] = 0;
  }
  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

/**
 * 연결영역들 중 "사람 본체"를 고른다.
 * - 너무 작은(잡음) 컴포넌트는 제외
 * - 거울 난간/가방끈처럼 가늘고 긴 컴포넌트는 우선 제외
 * - 남은 후보 중 면적(픽셀 수)이 가장 큰 것을 선택
 * - 필터링 후 후보가 하나도 없으면, 최소 면적 조건만 적용해 다시 시도한다
 *   (완전히 실패하는 것보다는 최선의 후보를 쓰는 편이 낫다).
 */
export function selectBodyComponent(
  components: Component[],
  analysisWidth: number,
  analysisHeight: number
): Component | null {
  const totalPixels = analysisWidth * analysisHeight;
  const minArea = totalPixels * MIN_COMPONENT_AREA_RATIO;

  const sizable = components.filter((c) => c.area >= minArea);
  if (sizable.length === 0) return null;

  const notThin = sizable.filter((c) => {
    const w = c.maxX - c.minX + 1;
    const h = c.maxY - c.minY + 1;
    const thinness = Math.min(w, h) / Math.max(w, h);
    return thinness >= THIN_ASPECT_RATIO;
  });

  const pool = notThin.length > 0 ? notThin : sizable;
  pool.sort((a, b) => b.area - a.area);
  return pool[0];
}

/**
 * 누끼 결과를 사람 bounding box 기준으로 정규화한다.
 *
 * 1) 저해상도로 축소한 alpha 마스크에서 연결영역(connected component)을
 *    찾아 "사람 본체"를 고른다 (거울 난간·가방끈 같은 떨어진/가느다란
 *    잔여물은 제외) - 이게 기존 "alpha>0 전체 bbox" 방식의 핵심 결함을 고친 부분.
 * 1.5) 선택된 컴포넌트에 실제로 속한 픽셀만 격리하고, opening by
 *    reconstruction(침식 → 가장 큰 core만 원래 두께로 복원)으로 사람과
 *    alpha상 이어진 얇고 긴 잔여물(엘리베이터 손잡이/난간 등)을 추가로
 *    제거한다. 그 결과를 원본 해상도 alpha에도 실제로 적용한다(crop만
 *    하는 게 아니라 픽셀 자체를 지운다) - v3에서 추가, /dev/mask-cleanup-test로 검증.
 * 2) 그 컴포넌트를 원본 해상도 좌표로 확대 매핑하고, 그 주변 창(window)
 *    안에서만 정밀 bbox를 다시 계산한다 (하위 해상도에서 잘린 경계 보정,
 *    가방/머리카락처럼 본체에 실제로 붙어있는 디테일은 유지).
 * 3) bbox 상하좌우에 4% padding을 더한다.
 * 4) 고정 캔버스(2:3 비율)에 다시 배치한다.
 * 5) 발(bbox 하단)이 항상 캔버스 하단의 같은 위치에 오도록 정렬한다.
 * 6) 가로 중앙 정렬한다.
 * 7) 머리~발 길이가 캔버스 높이의 95%를 차지하도록 스케일링한다
 *    → 같은 사람이 다른 거리/줌으로 찍혀도 화면상 크기가 비슷해 보인다.
 *
 * 8) (선택) 자동 결과가 "의심스러울" 때만 - personalCorrections로 넘어온
 *    이 사용자의 과거 수동 보정 기록을 참고해 bbox를 살짝 옮기고 크기를
 *    조정한다("personal crop correction heuristic" - 모델 재학습이 아니라
 *    순수 산술 보정). 정상적인 사진은 이 단계를 타지 않고 그대로 진행된다.
 *
 * 사람 본체를 못 찾으면 null - 호출부는 정규화 없이 원본 누끼로 폴백한다.
 */
async function normalizeCutout(
  cutoutBlob: Blob,
  personalCorrections?: ManualCropCorrectionRecord[]
): Promise<{ blob: Blob; autoCrop: AutoCropInfo } | null> {
  try {
    const bitmap = await createImageBitmap(cutoutBlob);
    try {
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = bitmap.width;
      srcCanvas.height = bitmap.height;
      const srcCtx = srcCanvas.getContext("2d");
      if (!srcCtx) return null;
      srcCtx.drawImage(bitmap, 0, 0);

      // 1) 저해상도 분석용 캔버스
      const analysisScale = Math.min(1, COMPONENT_ANALYSIS_MAX_DIM / Math.max(bitmap.width, bitmap.height));
      const analysisWidth = Math.max(1, Math.round(bitmap.width * analysisScale));
      const analysisHeight = Math.max(1, Math.round(bitmap.height * analysisScale));

      const analysisCanvas = document.createElement("canvas");
      analysisCanvas.width = analysisWidth;
      analysisCanvas.height = analysisHeight;
      const analysisCtx = analysisCanvas.getContext("2d");
      if (!analysisCtx) return null;
      analysisCtx.drawImage(srcCanvas, 0, 0, analysisWidth, analysisHeight);
      const analysisImageData = analysisCtx.getImageData(0, 0, analysisWidth, analysisHeight);

      const binaryMask = buildBinaryMask(analysisImageData, ALPHA_THRESHOLD);
      const closedMask = morphologicalClose(binaryMask, analysisWidth, analysisHeight, MORPH_CLOSE_RADIUS);
      // 픽셀별 컴포넌트 소속(label)까지 함께 구한다 - 선택된 컴포넌트에
      // 실제로 속한 픽셀만 격리하는 다음 단계에 필요하다.
      const { components, labels } = findConnectedComponentsLabeled(closedMask, analysisWidth, analysisHeight);
      const bodyComponent = selectBodyComponent(components, analysisWidth, analysisHeight);
      if (!bodyComponent) return null;
      const bodyLabel = components.indexOf(bodyComponent);

      // 선택된 컴포넌트에 실제로 속한 픽셀만 격리한다 - 여기까지만 해도
      // "떨어진" 잔여물(별도 컴포넌트인데 이후 crop 창 안에 들어오는 것)은
      // 이미 제거된다. 기존 방식은 컴포넌트를 "고르기만" 하고 최종 이미지는
      // 원본 alpha를 그대로 복사해왔다 - 그게 crop 영역 안에 든 잔여물이
      // 계속 살아남던 원인이었다.
      const isolatedMask = new Uint8Array(closedMask.length);
      for (let i = 0; i < isolatedMask.length; i++) {
        isolatedMask[i] = labels[i] === bodyLabel ? 1 : 0;
      }

      // 사람과 alpha상 이어진 얇고 긴 잔여물(엘리베이터 손잡이/난간 등)
      // 제거: opening by reconstruction. 침식으로 얇은 다리를 끊고, 살아
      // 남은 가장 큰 core만 원래 마스크 범위 안에서 원래 두께로 복원한다 -
      // 팔/다리/긴소매/가방끈처럼 침식 반경(OPENING_EROSION_RADIUS)보다
      // 두꺼운 부위는 core가 살아남아 복원되고, 그보다 얇게 이어진 가지만
      // 끊긴 채로 사라진다. /dev/mask-cleanup-test에서 여러 샘플로 검증한 값.
      const eroded = erodeN(isolatedMask, analysisWidth, analysisHeight, OPENING_EROSION_RADIUS);
      const mainCore = findLargestComponent(eroded, analysisWidth, analysisHeight);
      let cleanedMask: Uint8Array;
      if (!mainCore) {
        // 침식 후 아무 것도 안 남으면(사람이 매우 얇게 찍힌 극단적 케이스)
        // cleanup을 포기한다 - 사람이 잘리는 것보다 잔여물이 남는 편이 낫다는
        // 보수적 원칙.
        cleanedMask = isolatedMask;
      } else {
        const coreOnly = isolateComponentMask(eroded, analysisWidth, analysisHeight, mainCore);
        cleanedMask = reconstructByDilation(
          coreOnly,
          isolatedMask,
          analysisWidth,
          analysisHeight,
          OPENING_EROSION_RADIUS + 2
        );
      }
      const cleanedBBoxLow = maskBoundingBoxLowRes(cleanedMask, analysisWidth, analysisHeight);
      if (!cleanedBBoxLow) return null;

      // cleanup된 저해상도 마스크를 원본 해상도로 올려 실제 alpha에도
      // 적용한다 - crop만 하는 게 아니라 잔여물을 실제 픽셀에서 지운다.
      const maskedCanvas = applyLowResMaskToFullRes(bitmap, cleanedMask, analysisWidth, analysisHeight);
      if (!maskedCanvas) return null;
      const maskedCtx = maskedCanvas.getContext("2d");
      if (!maskedCtx) return null;
      const maskedImageData = maskedCtx.getImageData(0, 0, maskedCanvas.width, maskedCanvas.height);

      // 2) 저해상도 컴포넌트(cleanup 후)를 원본 좌표로 확대 매핑 + 여유 창(margin) 부여
      const scaleBack = bitmap.width / analysisWidth;
      const compW = cleanedBBoxLow.maxX - cleanedBBoxLow.minX + 1;
      const compH = cleanedBBoxLow.maxY - cleanedBBoxLow.minY + 1;
      const marginX = compW * scaleBack * COMPONENT_WINDOW_MARGIN_RATIO;
      const marginY = compH * scaleBack * COMPONENT_WINDOW_MARGIN_RATIO;

      const windowRegion: BoundingBox = {
        minX: cleanedBBoxLow.minX * scaleBack - marginX,
        minY: cleanedBBoxLow.minY * scaleBack - marginY,
        maxX: (cleanedBBoxLow.maxX + 1) * scaleBack + marginX,
        maxY: (cleanedBBoxLow.maxY + 1) * scaleBack + marginY,
      };

      const bbox = findAlphaBoundingBox(maskedImageData, windowRegion);
      if (!bbox) return null;

      const bboxWidth = bbox.maxX - bbox.minX + 1;
      const bboxHeight = bbox.maxY - bbox.minY + 1;

      // 이 시점의 bitmap은 세그멘테이션 입력(원본을 종횡비 그대로 축소한
      // 사본)과 같은 크기라, bbox를 0~1 비율로 표현하면 원본 좌표계와 완전히
      // 동일한 값이 된다(균등 축소는 비율을 바꾸지 않는다) - 그래서 해상도
      // 걱정 없이 이 비율을 그대로 manualCropCorrection 비교/저장에 쓸 수 있다.
      const rawBBoxRatio: CropRatioBox = {
        x: bbox.minX / bitmap.width,
        y: bbox.minY / bitmap.height,
        width: bboxWidth / bitmap.width,
        height: bboxHeight / bitmap.height,
      };
      const imageIsPortrait = bitmap.height >= bitmap.width;

      // 8) 자동 결과가 의심스러운지 먼저 판정한다 (padding 없는 원래 bbox
      // 기준 - 아래에서 최종 계산할 때와 같은 스케일 공식을 재사용).
      // personalCorrections가 있을 때만(정상 production 경로) 계산하는 게
      // 원래 로직이다 - 개발 환경에서는 기록이 0개일 때도 "왜 적용 안
      // 됐는지"를 로그로 보여주기 위해 이 블록에 한 번 더 들어간다. 두
      // 경우 모두 실제 crop 판단/적용 로직은 전혀 다르지 않다.
      let effectiveBBoxRatio = rawBBoxRatio;
      let personalizationApplied = false;
      if ((personalCorrections && personalCorrections.length > 0) || (isPersonalCropDebugEnabled && personalCorrections)) {
        const padX0 = bboxWidth * CROP_PADDING_RATIO;
        const cropW0 =
          Math.min(bitmap.width, bbox.maxX + 1 + padX0) - Math.max(0, bbox.minX - padX0);
        let scale0 = (NORMALIZE_CANVAS_HEIGHT * BODY_HEIGHT_RATIO) / bboxHeight;
        const widthConstrained0 = cropW0 * scale0 > NORMALIZE_CANVAS_WIDTH;
        if (widthConstrained0) scale0 = NORMALIZE_CANVAS_WIDTH / cropW0;
        const effectiveBodyHeightRatio0 = (bboxHeight * scale0) / NORMALIZE_CANVAS_HEIGHT;

        const suspicious = isAutoResultSuspicious({
          bboxRatio: rawBBoxRatio,
          imageIsPortrait,
          widthConstrained: widthConstrained0,
          effectiveBodyHeightRatio: effectiveBodyHeightRatio0,
          targetBodyHeightRatio: BODY_HEIGHT_RATIO,
        });

        // 실제 개인화 적용 여부/방법은 원래 로직 그대로: 의심스럽고 기록이
        // 있을 때만 시도한다.
        let diagnostics: PersonalizationDiagnostics | null = null;
        if (suspicious && personalCorrections && personalCorrections.length > 0) {
          diagnostics = computePersonalizedAutoCropWithDiagnostics(rawBBoxRatio, imageIsPortrait, personalCorrections);
          if (diagnostics.result) {
            effectiveBBoxRatio = diagnostics.result;
            personalizationApplied = true;
          }
        }

        if (isPersonalCropDebugEnabled) {
          logPersonalCropDecision({
            totalSamples: personalCorrections?.length ?? 0,
            suspicious,
            diagnostics,
            autoCropRatio: rawBBoxRatio,
            finalCropRatio: effectiveBBoxRatio,
            applied: personalizationApplied,
          });
        }
      }

      // 보정이 적용됐다면 비율을 다시 이 bitmap의 픽셀 bbox로 되돌린다 -
      // 아래 padding/스케일/발 정렬 로직은 그대로 재사용한다.
      const effectiveBBox: BoundingBox = personalizationApplied
        ? {
            minX: effectiveBBoxRatio.x * bitmap.width,
            minY: effectiveBBoxRatio.y * bitmap.height,
            maxX: (effectiveBBoxRatio.x + effectiveBBoxRatio.width) * bitmap.width - 1,
            maxY: (effectiveBBoxRatio.y + effectiveBBoxRatio.height) * bitmap.height - 1,
          }
        : bbox;
      const effectiveWidth = effectiveBBox.maxX - effectiveBBox.minX + 1;
      const effectiveHeight = effectiveBBox.maxY - effectiveBBox.minY + 1;

      const padX = effectiveWidth * CROP_PADDING_RATIO;
      const padY = effectiveHeight * CROP_PADDING_RATIO;

      const cropMinX = Math.max(0, effectiveBBox.minX - padX);
      const cropMinY = Math.max(0, effectiveBBox.minY - padY);
      const cropMaxX = Math.min(bitmap.width, effectiveBBox.maxX + 1 + padX);
      const cropMaxY = Math.min(bitmap.height, effectiveBBox.maxY + 1 + padY);
      const cropWidth = cropMaxX - cropMinX;
      const cropHeight = cropMaxY - cropMinY;
      if (cropWidth <= 0 || cropHeight <= 0) return null;

      // 머리~발(padding 제외한 실제 bbox) 길이 기준으로 스케일을 정한다.
      // 사람이 캔버스보다 옆으로 넘치면 가로 기준으로 한 번 더 제한한다.
      let scale = (NORMALIZE_CANVAS_HEIGHT * BODY_HEIGHT_RATIO) / effectiveHeight;
      if (cropWidth * scale > NORMALIZE_CANVAS_WIDTH) {
        scale = NORMALIZE_CANVAS_WIDTH / cropWidth;
      }

      const destWidth = cropWidth * scale;
      const destHeight = cropHeight * scale;
      const destX = (NORMALIZE_CANVAS_WIDTH - destWidth) / 2;

      // 발(bbox 하단)이 crop 좌표계에서 얼마나 아래에 있는지 구해서,
      // 캔버스 하단의 고정 위치에 오도록 세로 위치를 역산한다.
      const footYInCrop = effectiveBBox.maxY + 1 - cropMinY;
      const canvasFootY = NORMALIZE_CANVAS_HEIGHT * (1 - FOOT_BOTTOM_MARGIN_RATIO);
      const destY = canvasFootY - footYInCrop * scale;

      const outCanvas = document.createElement("canvas");
      outCanvas.width = NORMALIZE_CANVAS_WIDTH;
      outCanvas.height = NORMALIZE_CANVAS_HEIGHT;
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) return null;
      // 캔버스는 기본적으로 투명하다 - 배경을 채우지 않아야 누끼 알파가 유지된다.
      // srcCanvas가 아니라 maskedCanvas(cleanup 적용 후)를 그린다 - 그래야
      // crop 영역 안에 남아있던 잔여물도 최종 이미지에서 실제로 사라진다.
      outCtx.drawImage(
        maskedCanvas,
        cropMinX,
        cropMinY,
        cropWidth,
        cropHeight,
        destX,
        destY,
        destWidth,
        destHeight
      );

      const blob = await new Promise<Blob | null>((resolve) => {
        outCanvas.toBlob((b) => resolve(b), "image/png");
      });
      if (!blob) return null;

      return { blob, autoCrop: { bboxRatio: rawBBoxRatio, personalizationApplied } };
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

async function runCutout(
  file: File | Blob,
  personalCorrections?: ManualCropCorrectionRecord[]
): Promise<CutoutResult | null> {
  try {
    const segmentInput = await downscaleImage(file, SEGMENT_INPUT_MAX_DIMENSION, 0.9);
    const rawCutout = await removeBackground(segmentInput, {
      device: "cpu",
      output: { format: "image/png" },
    });

    // 정규화에 실패해도(본체 컴포넌트를 못 찾는 등) 누끼 자체는 살려서,
    // 사람 크기가 제각각이더라도 최소한 배경은 제거된 상태로 저장되게 한다.
    const normalized = await normalizeCutout(rawCutout, personalCorrections);
    const baseForResize = normalized?.blob ?? rawCutout;

    const [detailBlob, thumbBlob] = await Promise.all([
      resizeTransparent(baseForResize, DETAIL_MAX_DIMENSION, DETAIL_QUALITY),
      resizeTransparent(baseForResize, THUMB_MAX_DIMENSION, THUMB_QUALITY),
    ]);

    if (!detailBlob || !thumbBlob) return null;
    return { detailBlob, thumbBlob, autoCrop: normalized?.autoCrop ?? null };
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

/** generateCutout/generateCutoutWithDiagnostics가 공유하는 직렬화 큐. */
function enqueueCutoutTask<T>(task: () => Promise<T>): Promise<T> {
  const result = cutoutQueue.then(task, task);
  // 이 작업이 실패해도 큐 자체는 계속 이어져야 다음 작업이 진행된다.
  cutoutQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * 원본 거울셀카에서 사람 전체(머리~신발)를 하나의 객체로 배경에서 분리하고
 * 사람 본체 bounding box 기준으로 크기/위치를 정규화해, 상세용/목록용 두
 * 사이즈의 투명 이미지를 만든다. 무거운 세그멘테이션 추론은 한 번만
 * 실행하고, 두 사이즈는 정규화된 결과를 캔버스로 리사이즈만 하므로 빠르다.
 * 실패하면(모델 로드 실패, 메모리 부족 등) null - 호출부는 원본으로 폴백해야 한다.
 * 앱 전체에서 동시에 최대 1건만 실행되도록 직렬화되어 있다.
 *
 * personalCorrections를 넘기면, 자동 결과가 "의심스러울" 때만(정상 사진은
 * 영향 없음) 이 사용자의 과거 수동 보정 기록을 참고해 bbox를 살짝 조정한다
 * ("personal crop correction heuristic" - 모델 재학습 아님). 이미 메모리에
 * 있는 배열을 넘기는 것뿐이라 추가 네트워크 호출이나 유의미한 처리 시간
 * 증가가 없다 - Firestore 조회는 호출부(useLookUpload 등)가 세션당 한 번만
 * 캐시해서 수행한다(personalCropHeuristic.ts).
 */
export function generateCutout(
  file: File | Blob,
  personalCorrections?: ManualCropCorrectionRecord[]
): Promise<CutoutResult | null> {
  return enqueueCutoutTask(() => runCutout(file, personalCorrections));
}

// --- 진단 전용 -------------------------------------------------------------

export type CutoutDiagnosticStep = "model-or-segment" | "normalize-or-resize";

export type CutoutDiagnosticResult =
  | { ok: true; result: CutoutResult; usedNormalization: boolean }
  | {
      ok: false;
      step: CutoutDiagnosticStep;
      error: unknown;
      /** removeBackground의 progress 콜백이 마지막으로 보고한 phase 키 (CDN fetch인지 추론인지 구분용). */
      lastProgressPhase: string | null;
    };

async function runCutoutWithDiagnostics(
  file: File | Blob,
  personalCorrections?: ManualCropCorrectionRecord[]
): Promise<CutoutDiagnosticResult> {
  let lastProgressPhase: string | null = null;

  let rawCutout: Blob;
  try {
    const segmentInput = await downscaleImage(file, SEGMENT_INPUT_MAX_DIMENSION, 0.9);
    rawCutout = await removeBackground(segmentInput, {
      device: "cpu",
      output: { format: "image/png" },
      progress: (key) => {
        lastProgressPhase = key;
      },
    });
  } catch (error) {
    return { ok: false, step: "model-or-segment", error, lastProgressPhase };
  }

  try {
    const normalized = await normalizeCutout(rawCutout, personalCorrections);
    const baseForResize = normalized?.blob ?? rawCutout;

    const [detailBlob, thumbBlob] = await Promise.all([
      resizeTransparent(baseForResize, DETAIL_MAX_DIMENSION, DETAIL_QUALITY),
      resizeTransparent(baseForResize, THUMB_MAX_DIMENSION, THUMB_QUALITY),
    ]);

    if (!detailBlob || !thumbBlob) {
      return {
        ok: false,
        step: "normalize-or-resize",
        error: new Error("리사이즈 결과가 비어 있음 (캔버스 인코딩 실패)"),
        lastProgressPhase,
      };
    }

    return {
      ok: true,
      result: { detailBlob, thumbBlob, autoCrop: normalized?.autoCrop ?? null },
      usedNormalization: normalized !== null,
    };
  } catch (error) {
    return { ok: false, step: "normalize-or-resize", error, lastProgressPhase };
  }
}

/**
 * generateCutout과 같은 파이프라인이지만 실패를 삼키지 않고 어느 단계에서
 * 왜 실패했는지 그대로 돌려준다. /dev/cutout-migrate의 단계별 진단 UI 전용 -
 * 일반 업로드 경로(useLookUpload.ts)는 계속 generateCutout(폴백 우선)을 쓴다.
 */
export function generateCutoutWithDiagnostics(
  file: File | Blob,
  personalCorrections?: ManualCropCorrectionRecord[]
): Promise<CutoutDiagnosticResult> {
  return enqueueCutoutTask(() => runCutoutWithDiagnostics(file, personalCorrections));
}
