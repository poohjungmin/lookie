// "Personal crop correction heuristic" - 실제 모델 학습/파인튜닝이 아니라,
// 사용자가 수동으로 고친 crop 기록을 모아 가벼운 산술로 자동 crop을 살짝
// 보정하는 로직. 이 파일은 순수 함수만 모아둔다 (Firebase/DOM 의존 없음) -
// cutout.ts가 Firebase에 의존하지 않는 기존 구조를 그대로 유지하기 위해,
// Firestore 읽기/쓰기는 personalCropHeuristic.ts로 분리했다.

/** 0~1 사이 비율로 표현한 crop 사각형 - 해상도가 달라도 그대로 재사용 가능하다. */
export type CropRatioBox = { x: number; y: number; width: number; height: number };

export type CorrectionDelta = {
  /** (수동 crop 중심 - 자동 crop 중심) / 이미지 너비. */
  centerXDeltaRatio: number;
  centerYDeltaRatio: number;
  /** 수동 crop 너비 / 자동 crop 너비. 1보다 작으면 사용자가 더 좁게 잡았다는 뜻. */
  widthRatio: number;
  heightRatio: number;
};

export type ManualCropCorrectionRecord = {
  imageIsPortrait: boolean;
  autoCropRatio: CropRatioBox;
  manualCropRatio: CropRatioBox;
  correction: CorrectionDelta;
};

// 과거 평균 보정값을 그대로 100% 적용하지 않는다 - 30~50% 사이를 권장값으로
// 잡고 0.4로 시작한다. 나중에 조절하기 쉽도록 상수로 분리.
export const PERSONAL_CORRECTION_STRENGTH = 0.4;
// 이 개수 미만이면(비슷한 촬영 패턴으로 필터링한 뒤 기준) 개인화를 적용하지
// 않고 순수 자동 결과를 그대로 쓴다.
export const MIN_CORRECTION_SAMPLES = 5;

// "비슷한 촬영 패턴"으로 볼 임계값 (요구사항 7) - AI 임베딩 없이 가벼운
// 수치 몇 개(가로/세로, 자동 bbox의 너비/높이/중심 비율)만 비교한다.
const HEIGHT_RATIO_SIMILARITY_TOLERANCE = 0.18;
const WIDTH_RATIO_SIMILARITY_TOLERANCE = 0.18;
const CENTER_SIMILARITY_TOLERANCE = 0.15;

// 보정 적용 후에도 사람이 잘리지 않도록, 자동 bbox 대비 이 비율보다 작아지진
// 않는다 (최소 padding 보장).
const MIN_SIZE_RATIO_OF_AUTO = 0.6;

function centerOf(box: CropRatioBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** 자동 crop과 사용자가 최종 지정한 crop의 차이를 계산한다 (manualCropCorrection.correction). */
export function computeCorrectionDelta(autoCropRatio: CropRatioBox, manualCropRatio: CropRatioBox): CorrectionDelta {
  const autoCenter = centerOf(autoCropRatio);
  const manualCenter = centerOf(manualCropRatio);
  return {
    centerXDeltaRatio: manualCenter.x - autoCenter.x,
    centerYDeltaRatio: manualCenter.y - autoCenter.y,
    widthRatio: autoCropRatio.width > 0 ? manualCropRatio.width / autoCropRatio.width : 1,
    heightRatio: autoCropRatio.height > 0 ? manualCropRatio.height / autoCropRatio.height : 1,
  };
}

/** 세로/가로 사진, 자동 bbox의 크기·위치가 크게 다른 기록은 평균에서 뺀다. */
export function filterSimilarCorrections(
  records: ManualCropCorrectionRecord[],
  target: { imageIsPortrait: boolean; autoCropRatio: CropRatioBox }
): ManualCropCorrectionRecord[] {
  const targetCenter = centerOf(target.autoCropRatio);
  return records.filter((r) => {
    if (r.imageIsPortrait !== target.imageIsPortrait) return false;
    if (Math.abs(r.autoCropRatio.height - target.autoCropRatio.height) > HEIGHT_RATIO_SIMILARITY_TOLERANCE) return false;
    if (Math.abs(r.autoCropRatio.width - target.autoCropRatio.width) > WIDTH_RATIO_SIMILARITY_TOLERANCE) return false;
    const c = centerOf(r.autoCropRatio);
    if (Math.abs(c.x - targetCenter.x) > CENTER_SIMILARITY_TOLERANCE) return false;
    if (Math.abs(c.y - targetCenter.y) > CENTER_SIMILARITY_TOLERANCE) return false;
    return true;
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 여러 보정 기록의 대표값을 계산한다. 단순 평균 대신 median을 쓴다 - 한두
 * 개의 극단적인 보정(예: 실수로 엉뚱하게 crop한 기록)이 전체 평균을
 * 크게 흔들지 않도록 하기 위함.
 */
export function medianCorrection(records: ManualCropCorrectionRecord[]): CorrectionDelta | null {
  if (records.length === 0) return null;
  return {
    centerXDeltaRatio: median(records.map((r) => r.correction.centerXDeltaRatio)),
    centerYDeltaRatio: median(records.map((r) => r.correction.centerYDeltaRatio)),
    widthRatio: median(records.map((r) => r.correction.widthRatio)),
    heightRatio: median(records.map((r) => r.correction.heightRatio)),
  };
}

/**
 * 대표 보정값을 강도(strength, 0~1)만큼만 반영해 자동 bbox를 살짝 옮기고
 * 크기를 조정한다. 100% 그대로 적용하지 않고, 결과 크기가 자동 bbox의
 * MIN_SIZE_RATIO_OF_AUTO 아래로 줄어들지 않도록 막아 사람이 잘리는 일을 막는다.
 */
export function applyPersonalCorrection(
  autoCropRatio: CropRatioBox,
  correction: CorrectionDelta,
  strength: number
): CropRatioBox {
  const center = centerOf(autoCropRatio);
  const newCenterX = center.x + correction.centerXDeltaRatio * strength;
  const newCenterY = center.y + correction.centerYDeltaRatio * strength;

  const widthMultiplier = 1 + (correction.widthRatio - 1) * strength;
  const heightMultiplier = 1 + (correction.heightRatio - 1) * strength;

  const minWidth = autoCropRatio.width * MIN_SIZE_RATIO_OF_AUTO;
  const minHeight = autoCropRatio.height * MIN_SIZE_RATIO_OF_AUTO;

  const newWidth = Math.max(minWidth, Math.min(1, autoCropRatio.width * widthMultiplier));
  const newHeight = Math.max(minHeight, Math.min(1, autoCropRatio.height * heightMultiplier));

  const x = Math.min(Math.max(newCenterX - newWidth / 2, 0), 1 - newWidth);
  const y = Math.min(Math.max(newCenterY - newHeight / 2, 0), 1 - newHeight);

  return { x, y, width: newWidth, height: newHeight };
}

/**
 * 자동 crop이 "의심스러울" 때만 호출하는 진입점. 비슷한 촬영 패턴의 기록이
 * MIN_CORRECTION_SAMPLES개 미만이면 보정하지 않고 null(= 자동 결과 그대로
 * 사용)을 돌려준다.
 */
export function computePersonalizedAutoCrop(
  autoCropRatio: CropRatioBox,
  imageIsPortrait: boolean,
  allRecords: ManualCropCorrectionRecord[]
): CropRatioBox | null {
  const similar = filterSimilarCorrections(allRecords, { imageIsPortrait, autoCropRatio });
  if (similar.length < MIN_CORRECTION_SAMPLES) return null;
  const correction = medianCorrection(similar);
  if (!correction) return null;
  return applyPersonalCorrection(autoCropRatio, correction, PERSONAL_CORRECTION_STRENGTH);
}

// --- 자동 결과가 "의심스러운지" 판정 ----------------------------------------

export type AutoResultQuality = {
  bboxRatio: CropRatioBox;
  imageIsPortrait: boolean;
  /** 정규화 스케일이 세로(BODY_HEIGHT_RATIO) 대신 가로 폭에 의해 제한됐는지 -
      거울 난간 등으로 bbox가 옆으로 넓어졌을 때의 대표적인 증상. */
  widthConstrained: boolean;
  /** 최종 캔버스에서 실제로 몸이 차지한 높이 비율. */
  effectiveBodyHeightRatio: number;
  /** 정규화가 원래 목표로 하는 몸 높이 비율 (BODY_HEIGHT_RATIO). */
  targetBodyHeightRatio: number;
};

// 목표 몸높이 비율의 85% 미만이면(위 widthConstrained와 함께 봤을 때) 의심.
const SUSPICIOUS_BODY_HEIGHT_SHORTFALL_RATIO = 0.85;
// bbox 가로/세로 비율이 이보다 크면(사람치고 지나치게 넓적하면) 의심 - 얇고
// 긴 잔여물이 붙어 bbox를 옆으로 늘렸을 가능성.
const SUSPICIOUS_BBOX_ASPECT_THRESHOLD = 0.85;

export function isAutoResultSuspicious(quality: AutoResultQuality): boolean {
  if (quality.widthConstrained) return true;
  if (quality.effectiveBodyHeightRatio < quality.targetBodyHeightRatio * SUSPICIOUS_BODY_HEIGHT_SHORTFALL_RATIO) {
    return true;
  }
  const bboxAspect = quality.bboxRatio.width / Math.max(quality.bboxRatio.height, 1e-6);
  if (bboxAspect > SUSPICIOUS_BBOX_ASPECT_THRESHOLD) return true;
  return false;
}
