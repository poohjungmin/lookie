"use client";

// 개발용 테스트 페이지 - production 누끼 파이프라인/Firestore/Storage에는
// 전혀 쓰지 않는다. 사진을 선택하면 브라우저 메모리 안에서만:
//   1. 기존과 동일한 background removal + bbox 선택("A", cutout.ts와
//      완전히 같은 함수/상수 재사용)
//   2. 거기에 얇은 가지(난간/봉 등) 제거를 추가한 결과("B")
// 를 나란히 비교해서 보여준다. 아무 것도 저장하지 않는다 - 파일 선택 ->
// 화면 표시가 전부.

import { useState } from "react";
import { removeBackground } from "@imgly/background-removal";
import { downscaleImage } from "@/lib/downscaleImage";
import { SEGMENT_INPUT_MAX_DIMENSION } from "@/lib/cutout";
import {
  analyzeAndCleanMask,
  applyMaskToFullRes,
  findAlphaBoundingBox,
  placeOnNormalizedCanvas,
  scaleBBoxToSource,
  type CleanupMetrics,
} from "@/lib/maskCleanupTest";

type RunResult = {
  originalPreviewUrl: string;
  rawCutoutUrl: string;
  finalAUrl: string;
  finalBUrl: string;
  isolatedMaskUrl: string;
  cleanedMaskUrl: string;
  removedMaskUrl: string;
  metrics: CleanupMetrics;
  bgRemovalMs: number;
};

function maskToDataUrl(mask: Uint8Array, width: number, height: number, rgb: [number, number, number]): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < mask.length; i++) {
    imageData.data[i * 4] = rgb[0];
    imageData.data[i * 4 + 1] = rgb[1];
    imageData.data[i * 4 + 2] = rgb[2];
    imageData.data[i * 4 + 3] = mask[i] ? 255 : 0;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob ? URL.createObjectURL(blob) : "");
    }, "image/png");
  });
}

export default function MaskCleanupTestPage() {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);

  async function handleFile(file: File) {
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const originalPreviewUrl = URL.createObjectURL(file);

      // 1) 기존과 동일한 전처리 (cutout.ts runCutout과 동일한 순서/상수)
      setStatus("배경 제거 준비 중…");
      const segmentInput = await downscaleImage(file, SEGMENT_INPUT_MAX_DIMENSION, 0.9);

      setStatus("배경 제거 중… (첫 실행은 모델 다운로드로 오래 걸릴 수 있어요)");
      const bgStart = performance.now();
      const rawCutout = await removeBackground(segmentInput, {
        device: "cpu",
        output: { format: "image/png" },
      });
      const bgRemovalMs = performance.now() - bgStart;
      const rawCutoutUrl = URL.createObjectURL(rawCutout);

      // 2) 기존 방식(A) 컴포넌트 선택 + 개선 방식(B) cleanup
      setStatus("마스크 분석 + cleanup 중…");
      const analysis = await analyzeAndCleanMask(rawCutout);
      if (!analysis) {
        setError("사람 컴포넌트를 찾지 못했어요 (기존 파이프라인도 이 사진은 정규화 없이 원본 누끼로 폴백해요).");
        setRunning(false);
        setStatus(null);
        return;
      }
      const { bitmap, isolatedMask, cleanedMask, metrics } = analysis;

      // 원본 해상도 캔버스 (A/B 최종 배치의 소스)
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = bitmap.width;
      fullCanvas.height = bitmap.height;
      const fullCtx = fullCanvas.getContext("2d");
      if (!fullCtx) throw new Error("캔버스 컨텍스트 생성 실패");
      fullCtx.drawImage(bitmap, 0, 0);
      const fullImageData = fullCtx.getImageData(0, 0, bitmap.width, bitmap.height);

      // A) 기존 방식: 컴포넌트 주변 window에서 원본 alpha 그대로 bbox 계산 (cutout.ts와 동일)
      const windowRegion = scaleBBoxToSource(metrics.originalBBoxPx, metrics.analysisWidth, bitmap.width);
      const bboxA = findAlphaBoundingBox(fullImageData, windowRegion);
      const finalACanvas = bboxA ? placeOnNormalizedCanvas(fullCanvas, bboxA) : document.createElement("canvas");

      // B) 개선 방식: cleanup된 마스크를 원본 해상도로 확대 적용한 뒤 bbox 계산
      const cleanedFullCanvas = applyMaskToFullRes(bitmap, cleanedMask, metrics.analysisWidth, metrics.analysisHeight);
      const cleanedFullCtx = cleanedFullCanvas.getContext("2d");
      const cleanedFullImageData = cleanedFullCtx?.getImageData(0, 0, cleanedFullCanvas.width, cleanedFullCanvas.height);
      const bboxB = cleanedFullImageData ? findAlphaBoundingBox(cleanedFullImageData) : null;
      const finalBCanvas = bboxB
        ? placeOnNormalizedCanvas(cleanedFullCanvas, bboxB)
        : document.createElement("canvas");

      const removedMask = new Uint8Array(isolatedMask.length);
      for (let i = 0; i < isolatedMask.length; i++) {
        removedMask[i] = isolatedMask[i] && !cleanedMask[i] ? 1 : 0;
      }

      const [finalAUrl, finalBUrl] = await Promise.all([canvasToUrl(finalACanvas), canvasToUrl(finalBCanvas)]);

      setResult({
        originalPreviewUrl,
        rawCutoutUrl,
        finalAUrl,
        finalBUrl,
        isolatedMaskUrl: maskToDataUrl(isolatedMask, metrics.analysisWidth, metrics.analysisHeight, [64, 64, 64]),
        cleanedMaskUrl: maskToDataUrl(cleanedMask, metrics.analysisWidth, metrics.analysisHeight, [64, 64, 64]),
        removedMaskUrl: maskToDataUrl(removedMask, metrics.analysisWidth, metrics.analysisHeight, [220, 38, 38]),
        metrics,
        bgRemovalMs,
      });
      bitmap.close();
      setStatus(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-5 pb-16 pt-10 sm:px-6">
      <p className="text-xs font-medium tracking-wide text-neutral-400">개발용 도구</p>
      <h1 className="mt-1 text-xl font-semibold text-neutral-900">누끼 잔여물 cleanup 테스트</h1>
      <p className="mt-2 text-sm text-neutral-500">
        철봉/난간/거울 프레임 같은 얇고 긴 배경 잔여물을, 기존 background removal + connected component 방식만으로
        얼마나 지울 수 있는지 확인하는 도구예요. 아무 것도 저장하지 않아요(Firestore/Storage 안 건드림) - 사진을
        고르면 브라우저에서만 계산해서 보여줘요.
      </p>

      <label className="mt-6 block w-full cursor-pointer rounded-xl border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500">
        {running ? status ?? "처리 중…" : "사진 선택하기"}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          disabled={running}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
      </label>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {result && (
        <div className="mt-8 space-y-8">
          {/* 지표 */}
          <section className="rounded-2xl border border-neutral-100 p-4 text-sm">
            <p className="font-medium text-neutral-800">측정값</p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-neutral-600">
              <p>분석 해상도</p>
              <p>
                {result.metrics.analysisWidth} × {result.metrics.analysisHeight}px
              </p>
              <p>배경 제거 시간</p>
              <p>{result.bgRemovalMs.toFixed(0)}ms</p>
              <p>기존 마스크 처리 시간(A)</p>
              <p>{result.metrics.timing.baselineMs.toFixed(1)}ms</p>
              <p>cleanup 추가 시간(B)</p>
              <p>{result.metrics.timing.cleanupMs.toFixed(1)}ms</p>
              <p className="font-medium text-neutral-800">전체 증가 시간</p>
              <p className="font-medium text-neutral-800">
                {(result.metrics.timing.baselineMs + result.metrics.timing.cleanupMs).toFixed(1)}ms 중 cleanup이{" "}
                {result.metrics.timing.cleanupMs.toFixed(1)}ms
              </p>
              <p>제거된 픽셀 비율</p>
              <p>{(result.metrics.removedAreaRatio * 100).toFixed(1)}% (전체 사람 영역 대비)</p>
              <p>bbox 너비 감소</p>
              <p>{(result.metrics.bboxWidthShrinkRatio * 100).toFixed(1)}%</p>
              <p>bbox 높이 감소</p>
              <p>{(result.metrics.bboxHeightShrinkRatio * 100).toFixed(1)}%</p>
            </div>
            <p className="mt-3 text-xs text-neutral-400">
              참고 heuristic: bbox 너비가 15~20% 이상 줄었는데 픽셀 손실은 5% 미만이면, 지워진 부분이 배경
              잔여물(가지)이었을 가능성이 높다는 신호예요. 반대로 픽셀 손실이 크면 사람 일부(팔/옷 등)가 같이
              잘렸을 수 있으니 아래 미리보기로 꼭 눈으로 확인하세요.
            </p>
          </section>

          {/* 최종 비교 */}
          <section>
            <p className="text-sm font-medium text-neutral-800">최종 누끼 비교 (정규화 배치까지 적용)</p>
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <p className="mb-1.5 text-center text-xs text-neutral-400">A. 기존 방식</p>
                <div className="aspect-[2/3] overflow-hidden rounded-xl bg-neutral-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.finalAUrl} alt="기존 방식 결과" className="h-full w-full object-contain" />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-center text-xs text-neutral-400">B. cleanup 적용</p>
                <div className="aspect-[2/3] overflow-hidden rounded-xl bg-neutral-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.finalBUrl} alt="cleanup 적용 결과" className="h-full w-full object-contain" />
                </div>
              </div>
            </div>
          </section>

          {/* 원본 / 배경제거 원본 */}
          <section>
            <p className="text-sm font-medium text-neutral-800">원본</p>
            <div className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <p className="mb-1.5 text-center text-xs text-neutral-400">촬영 원본</p>
                <div className="aspect-[3/4] overflow-hidden rounded-xl bg-neutral-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.originalPreviewUrl} alt="원본" className="h-full w-full object-contain" />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-center text-xs text-neutral-400">배경 제거 직후 (정규화 전)</p>
                <div className="aspect-[3/4] overflow-hidden rounded-xl bg-neutral-100">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.rawCutoutUrl} alt="배경 제거 직후" className="h-full w-full object-contain" />
                </div>
              </div>
            </div>
          </section>

          {/* 마스크 시각화 */}
          <section>
            <p className="text-sm font-medium text-neutral-800">
              마스크 시각화 (분석 해상도 {result.metrics.analysisWidth}×{result.metrics.analysisHeight}px)
            </p>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div>
                <p className="mb-1.5 text-center text-xs text-neutral-400">기존(선택된 컴포넌트)</p>
                <div className="aspect-[2/3] overflow-hidden rounded-xl bg-[repeating-conic-gradient(#e5e5e5_0%_25%,white_0%_50%)] bg-[length:16px_16px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.isolatedMaskUrl} alt="기존 마스크" className="h-full w-full object-contain" />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-center text-xs text-neutral-400">cleanup 후</p>
                <div className="aspect-[2/3] overflow-hidden rounded-xl bg-[repeating-conic-gradient(#e5e5e5_0%_25%,white_0%_50%)] bg-[length:16px_16px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.cleanedMaskUrl} alt="cleanup 후 마스크" className="h-full w-full object-contain" />
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-center text-xs text-neutral-400">제거된 영역(빨강)</p>
                <div className="aspect-[2/3] overflow-hidden rounded-xl bg-[repeating-conic-gradient(#e5e5e5_0%_25%,white_0%_50%)] bg-[length:16px_16px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result.removedMaskUrl} alt="제거된 영역" className="h-full w-full object-contain" />
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
