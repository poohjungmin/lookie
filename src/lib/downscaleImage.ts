"use client";

/**
 * 세그멘테이션/누끼 모델에 넣기 전에 원본 사진을 적당한 크기로 줄인다.
 * iPhone 카메라 원본(12MP+, 수 MB)을 리사이즈 없이 그대로 두 개의 무거운
 * WASM 모델(ONNX / MediaPipe)에 넣으면 캔버스 픽셀 버퍼 + 모델 텐서 메모리가
 * 겹쳐서 iOS Safari가 탭을 강제 종료시키는 문제가 실측 확인되었다.
 * 대부분의 세그멘테이션 모델은 어차피 내부적으로 1024px 안팎으로 리사이즈해서
 * 추론하므로, 미리 줄여도 품질 손해는 거의 없다.
 */
export async function downscaleImage(
  source: Blob,
  maxDimension = 1024,
  quality = 0.85
): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return source;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
    });
    return blob ?? source;
  } finally {
    bitmap.close();
  }
}
