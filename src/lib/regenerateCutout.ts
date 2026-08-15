"use client";

import { generateCutout, CURRENT_CUTOUT_VERSION } from "@/lib/cutout";
import { uploadLookCutout, uploadLookCutoutThumbnail, updateLookCutoutFields } from "@/lib/lookStore";
import { downloadOriginalWithFallbacks } from "@/lib/cutoutDownload";
import { withTimeout } from "@/lib/timeout";

const CUTOUT_TIMEOUT_MS = 60000; // 첫 실행 시 모델을 CDN에서 받아야 할 수 있어 넉넉히
const UPLOAD_TIMEOUT_MS = 20000;
const FIRESTORE_TIMEOUT_MS = 15000;

/**
 * 저장된 원본으로 누끼(cutout/cutout-thumb)를 다시 생성해 Storage/Firestore를
 * 덮어쓴다. EXIF·날씨·createdAt·lookId 등 다른 필드는 절대 건드리지 않는다.
 * 룩 상세 화면의 "누끼 다시 생성" 버튼과 /dev/cutout-migrate 일괄 도구가
 * 이 함수를 공유한다. 실패하면 그대로 throw한다 - 호출부가 에러 UI를 결정한다.
 */
export async function regenerateLookCutout(
  uid: string,
  look: { id: string; imageUrl: string; storagePath: string | null }
): Promise<void> {
  const { blob: originalBlob } = await downloadOriginalWithFallbacks(
    uid,
    look.id,
    look.storagePath,
    look.imageUrl
  );
  if (!originalBlob || originalBlob.size === 0) {
    throw new Error("다운로드된 원본 Blob 크기가 0");
  }

  const cutout = await withTimeout(
    generateCutout(originalBlob),
    CUTOUT_TIMEOUT_MS,
    "누끼 모델 로드/세그멘테이션/정규화"
  );
  if (!cutout) {
    throw new Error("누끼 생성 실패 (모델 로드 실패, 메모리 부족, 또는 사람을 찾지 못함)");
  }

  const [detail, thumb] = await Promise.all([
    withTimeout(uploadLookCutout(uid, look.id, cutout.detailBlob), UPLOAD_TIMEOUT_MS, "cutout 업로드"),
    withTimeout(
      uploadLookCutoutThumbnail(uid, look.id, cutout.thumbBlob),
      UPLOAD_TIMEOUT_MS,
      "cutout-thumb 업로드"
    ),
  ]);

  await withTimeout(
    updateLookCutoutFields(uid, look.id, {
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
