"use client";

const MAX_DIMENSION = 400;
const WEBP_QUALITY = 0.75;

/**
 * 업로드된 원본 사진에서 목록/캘린더/홈 화면용 작은 WebP 썸네일을 만든다
 * (긴 변 기준 400px, 품질 0.75). 실패하면(구형 브라우저, 지원하지 않는
 * 포맷 등) null을 반환한다 - 썸네일은 있으면 좋은 최적화일 뿐이라,
 * 실패해도 원본 업로드/저장 자체는 그대로 진행되어야 한다.
 */
export async function generateThumbnail(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, width, height);

      return await new Promise<Blob | null>((resolve) => {
        canvas.toBlob((blob) => resolve(blob), "image/webp", WEBP_QUALITY);
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}
