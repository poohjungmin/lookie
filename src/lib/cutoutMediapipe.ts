"use client";

import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import type { CutoutRunResult } from "@/lib/cutoutImgly";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let segmenterPromise: Promise<ImageSegmenter> | null = null;

function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: MODEL_URL,
          // iPhone Safari에서 GPU delegate가 불안정한 경우가 있어 비교의
          // 일관성을 위해 CPU로 고정한다.
          delegate: "CPU",
        },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })();
  }
  return segmenterPromise;
}

function loadImage(file: File): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => reject(new Error("이미지 로드 실패"));
    img.src = url;
  });
}

/**
 * DEVELOPMENT ONLY (비교 페이지 전용) — MediaPipe Selfie Segmenter
 * (Apache-2.0, 2클래스: 배경/사람)로 배경을 제거한다.
 * 세그멘터가 주는 건 마스크뿐이라, 원본을 캔버스에 그리고 마스크를
 * 알파 채널로 직접 합성한다.
 */
export async function runMediapipe(file: File): Promise<CutoutRunResult> {
  const started = performance.now();
  let objectUrl: string | null = null;
  try {
    const segmenter = await getSegmenter();
    const { img, url } = await loadImage(file);
    objectUrl = url;

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("캔버스 컨텍스트 생성 실패");
    ctx.drawImage(img, 0, 0);

    const result = segmenter.segment(img);
    const mask = result.categoryMask;
    if (!mask) throw new Error("세그멘테이션 마스크 없음");

    const maskData = mask.getAsUint8Array(); // 0 = 배경, 1 = 사람
    const maskWidth = mask.width;
    const maskHeight = mask.height;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = imageData.data;

    for (let y = 0; y < canvas.height; y++) {
      const my = Math.min(maskHeight - 1, Math.floor((y / canvas.height) * maskHeight));
      const rowOffset = my * maskWidth;
      for (let x = 0; x < canvas.width; x++) {
        const mx = Math.min(maskWidth - 1, Math.floor((x / canvas.width) * maskWidth));
        const isPerson = maskData[rowOffset + mx] === 1;
        if (!isPerson) {
          pixels[(y * canvas.width + x) * 4 + 3] = 0;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
    mask.close();
    result.close?.();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });
    if (!blob) throw new Error("PNG 인코딩 실패");

    return { ok: true, blob, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ms: Math.round(performance.now() - started),
    };
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
