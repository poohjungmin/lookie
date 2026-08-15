"use client";

import { generateCutout, CURRENT_CUTOUT_VERSION, type CutoutResult } from "@/lib/cutout";
import { uploadLookCutout, uploadLookCutoutThumbnail, updateLookCutoutFields } from "@/lib/lookStore";
import { withTimeout } from "@/lib/timeout";

const CUTOUT_TIMEOUT_MS = 60000; // 첫 실행 시 모델을 CDN에서 받아야 할 수 있어 넉넉히
const UPLOAD_TIMEOUT_MS = 20000;
const FIRESTORE_TIMEOUT_MS = 15000;

/** 생성된 cutout 결과를 Storage에 업로드하고 Firestore 누끼 필드만 덮어쓴다. */
async function uploadAndSaveCutout(uid: string, lookId: string, cutout: CutoutResult): Promise<void> {
  const [detail, thumb] = await Promise.all([
    withTimeout(uploadLookCutout(uid, lookId, cutout.detailBlob), UPLOAD_TIMEOUT_MS, "cutout 업로드"),
    withTimeout(
      uploadLookCutoutThumbnail(uid, lookId, cutout.thumbBlob),
      UPLOAD_TIMEOUT_MS,
      "cutout-thumb 업로드"
    ),
  ]);

  await withTimeout(
    updateLookCutoutFields(uid, lookId, {
      cutoutUrl: detail.cutoutUrl,
      cutoutStoragePath: detail.cutoutStoragePath,
      cutoutThumbnailUrl: thumb.cutoutThumbnailUrl,
      cutoutThumbnailStoragePath: thumb.cutoutThumbnailStoragePath,
      cutoutVersion: CURRENT_CUTOUT_VERSION,
    }),
    FIRESTORE_TIMEOUT_MS,
    "Firestore 업데이트"
  );
}

/**
 * 원본 사진에서 사용자가 직접 잘라낸 영역(크롭된 Blob)으로 누끼를 다시
 * 생성한다. 자동 정규화가 사람을 잘못 판단하는 예외 사진(사람이 원본에서
 * 작거나, 거울 난간 등이 오검출되는 경우)을 사용자가 직접 보정하기 위한
 * 경로다. 상세 화면의 "누끼 수정" 흐름이 이 함수를 쓴다. 원본 전체를
 * 그대로 넣던 이전의 "자동 재생성" 경로는 사용하지 않게 되어 제거했고,
 * 업로드 시 최초 누끼 생성(useLookUpload.ts)과 /dev/cutout-migrate 일괄
 * 마이그레이션은 이 파일과 무관하게 그대로 동작한다.
 * EXIF·날씨·createdAt·lookId 등 다른 필드는 절대 건드리지 않는다.
 * 실패하면 그대로 throw한다 - 호출부가 에러 UI를 결정한다.
 */
export async function regenerateLookCutoutFromCrop(
  uid: string,
  lookId: string,
  croppedBlob: Blob
): Promise<void> {
  if (!croppedBlob || croppedBlob.size === 0) {
    throw new Error("크롭된 이미지 Blob 크기가 0");
  }

  const cutout = await withTimeout(
    generateCutout(croppedBlob),
    CUTOUT_TIMEOUT_MS,
    "누끼 모델 로드/세그멘테이션/정규화"
  );
  if (!cutout) {
    throw new Error("누끼 생성 실패 (모델 로드 실패, 메모리 부족, 또는 사람을 찾지 못함)");
  }

  await uploadAndSaveCutout(uid, lookId, cutout);
}
