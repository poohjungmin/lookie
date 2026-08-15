"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const MIN_RECT_SIZE = 72; // crop 사각형의 최소 가로/세로 (stage px 기준)
const HANDLE_HIT_RADIUS = 26; // 모서리/변 핸들 터치 인식 반경 (stage px)
const HANDLE_VISUAL_SIZE = 14; // 화면에 보이는 핸들 점 크기 (px)
const MAX_ZOOM_MULTIPLIER = 4; // "화면에 꽉 차는 배율" 대비 최대 확대 배수

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Bounds = { x0: number; y0: number; x1: number; y1: number };
type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export type ManualCropResult = {
  croppedBlob: Blob;
  /** 원본 이미지 픽셀 좌표계에서, 사용자가 최종 지정한 crop 영역. personal
   * crop correction heuristic 기록(manualCrop)에 그대로 쓴다. */
  manualCropPixels: { x: number; y: number; width: number; height: number };
  naturalWidth: number;
  naturalHeight: number;
};

const HANDLE_IDS: HandleId[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function handleCenters(rect: Rect): Record<HandleId, Point> {
  const { x, y, w, h } = rect;
  return {
    nw: { x, y },
    n: { x: x + w / 2, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: y + h / 2 },
    se: { x: x + w, y: y + h },
    s: { x: x + w / 2, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: y + h / 2 },
  };
}

/** 이동/크기조절 후 rect가 항상 현재 이미지가 실제로 보이는 영역(bounds) 안에 있도록 자른다. */
function clampRectToBounds(rect: Rect, bounds: Bounds): Rect {
  const maxW = Math.max(MIN_RECT_SIZE, bounds.x1 - bounds.x0);
  const maxH = Math.max(MIN_RECT_SIZE, bounds.y1 - bounds.y0);
  const w = Math.min(rect.w, maxW);
  const h = Math.min(rect.h, maxH);
  const x = clamp(rect.x, bounds.x0, bounds.x1 - w);
  const y = clamp(rect.y, bounds.y0, bounds.y1 - h);
  return { x, y, w, h };
}

function moveRect(start: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  const x = clamp(start.x + dx, bounds.x0, bounds.x1 - start.w);
  const y = clamp(start.y + dy, bounds.y0, bounds.y1 - start.h);
  return { x, y, w: start.w, h: start.h };
}

/** 모서리/변 핸들 하나를 드래그했을 때 새 rect를 계산한다. 반대쪽 변은 고정. */
function resizeRect(mode: HandleId, start: Rect, dx: number, dy: number, bounds: Bounds): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;

  if (mode.includes("w")) left = clamp(start.x + dx, bounds.x0, right - MIN_RECT_SIZE);
  if (mode.includes("e")) right = clamp(start.x + start.w + dx, left + MIN_RECT_SIZE, bounds.x1);
  if (mode.includes("n")) top = clamp(start.y + dy, bounds.y0, bottom - MIN_RECT_SIZE);
  if (mode.includes("s")) bottom = clamp(start.y + start.h + dy, top + MIN_RECT_SIZE, bounds.y1);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

function boundsFromImageRect(
  imageRect: { left: number; top: number; right: number; bottom: number },
  stageSize: { w: number; h: number }
): Bounds {
  return {
    x0: Math.max(imageRect.left, 0),
    y0: Math.max(imageRect.top, 0),
    x1: Math.min(imageRect.right, stageSize.w),
    y1: Math.min(imageRect.bottom, stageSize.h),
  };
}

/**
 * 원본 사진 위에서 "사람이 존재하는 대략적인 영역"을 사용자가 직접 잡아
 * 늘리고 옮기는 자유 크롭 UI. 고정 비율 틀에 사진을 맞추던 이전 방식과
 * 달리, 사각형 자체를 손가락으로 이동/리사이즈한다. 최종 저장되는 누끼의
 * 비율은 여기서 정해지지 않는다 - 이 crop은 배경 제거 + 정규화 파이프라인에
 * 넣을 "원본 내 처리 영역"을 지정하는 용도일 뿐이고, 실제 출력 비율은
 * 기존 정규화 캔버스 규격(cutout.ts)을 그대로 따른다.
 * 무거운 크롭 라이브러리 없이 Pointer Events만으로 구현해 iPhone
 * Safari/PWA에서도 가볍게 동작한다.
 */
export default function ManualCutoutCropModal({
  imageBlob,
  busy,
  onCancel,
  onConfirm,
}: {
  imageBlob: Blob;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (result: ManualCropResult) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [rect, setRect] = useState<Rect | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pointers = useRef<Map<number, Point>>(new Map());
  const dragInfo = useRef<{
    pointerId: number;
    mode: "move" | HandleId;
    startPointer: Point;
    startRect: Rect;
  } | null>(null);
  const lastPinchDist = useRef<number | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(imageBlob);
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- Blob -> object URL 변환은
       외부 브라우저 API(URL.createObjectURL) 호출 결과를 state에 반영하는 것으로,
       렌더 중에는 할 수 없는 부수효과다 (cleanup에서 반드시 revoke도 필요). */
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageBlob]);

  useEffect(() => {
    function measure() {
      const el = stageRef.current;
      if (!el) return;
      setStageSize({ w: el.clientWidth, h: el.clientHeight });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [objectUrl]);

  // 이미지가 stage 전체를 벗어나지 않고 다 보이는 최소 배율("contain" 배율).
  const minScale = useMemo(() => {
    if (!naturalSize || !stageSize) return null;
    return Math.min(stageSize.w / naturalSize.w, stageSize.h / naturalSize.h);
  }, [naturalSize, stageSize]);

  const imageRect = useMemo(() => {
    if (!naturalSize || !stageSize) return null;
    const dispW = naturalSize.w * scale;
    const dispH = naturalSize.h * scale;
    const left = stageSize.w / 2 - dispW / 2 + pan.x;
    const top = stageSize.h / 2 - dispH / 2 + pan.y;
    return { left, top, right: left + dispW, bottom: top + dispH };
  }, [naturalSize, stageSize, scale, pan]);

  const defaultRect = useCallback(
    (s: number): Rect | null => {
      if (!naturalSize || !stageSize) return null;
      const dispW = naturalSize.w * s;
      const dispH = naturalSize.h * s;
      const left = stageSize.w / 2 - dispW / 2;
      const top = stageSize.h / 2 - dispH / 2;
      const bounds = boundsFromImageRect(
        { left, top, right: left + dispW, bottom: top + dispH },
        stageSize
      );
      const w = (bounds.x1 - bounds.x0) * 0.82;
      const h = (bounds.y1 - bounds.y0) * 0.88;
      const x = bounds.x0 + ((bounds.x1 - bounds.x0) - w) / 2;
      const y = bounds.y0 + ((bounds.y1 - bounds.y0) - h) / 2;
      return clampRectToBounds({ x, y, w, h }, bounds);
    },
    [naturalSize, stageSize]
  );

  const resetToDefault = useCallback(() => {
    if (minScale === null) return;
    setScale(minScale);
    setPan({ x: 0, y: 0 });
    setRect(defaultRect(minScale));
  }, [minScale, defaultRect]);

  // 이미지 로드 + stage 측정이 모두 끝나 minScale이 처음 정해지는 순간에만 초기화한다.
  useEffect(() => {
    if (minScale === null || rect !== null) return;
    /* eslint-disable react-hooks/set-state-in-effect -- 이미지 로드(naturalSize)와 stage
       측정(stageSize)이라는 두 개의 독립적인 비동기 이벤트가 모두 끝나야 초기 배율/
       위치/crop 사각형을 계산할 수 있어, 그 순간에 한 번만 동기화해야 한다. */
    setScale(minScale);
    setPan({ x: 0, y: 0 });
    setRect(defaultRect(minScale));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [minScale, rect, defaultRect]);

  const applyZoom = useCallback(
    (newScaleRaw: number, anchor: Point) => {
      if (!stageSize || !naturalSize || minScale === null) return;
      const maxScale = minScale * MAX_ZOOM_MULTIPLIER;
      const newScale = clamp(newScaleRaw, minScale, maxScale);

      const stageCx = stageSize.w / 2;
      const stageCy = stageSize.h / 2;
      const imgLeftBefore = stageCx - (naturalSize.w * scale) / 2 + pan.x;
      const imgTopBefore = stageCy - (naturalSize.h * scale) / 2 + pan.y;
      const contentX = (anchor.x - imgLeftBefore) / scale;
      const contentY = (anchor.y - imgTopBefore) / scale;

      const imgLeftAfter = anchor.x - contentX * newScale;
      const imgTopAfter = anchor.y - contentY * newScale;
      const newPan = {
        x: imgLeftAfter - stageCx + (naturalSize.w * newScale) / 2,
        y: imgTopAfter - stageCy + (naturalSize.h * newScale) / 2,
      };

      const dispW = naturalSize.w * newScale;
      const dispH = naturalSize.h * newScale;
      const newLeft = stageCx - dispW / 2 + newPan.x;
      const newTop = stageCy - dispH / 2 + newPan.y;
      const newBounds = boundsFromImageRect(
        { left: newLeft, top: newTop, right: newLeft + dispW, bottom: newTop + dispH },
        stageSize
      );

      setScale(newScale);
      setPan(newPan);
      setRect((prev) => (prev ? clampRectToBounds(prev, newBounds) : prev));
    },
    [stageSize, naturalSize, minScale, scale, pan]
  );

  function stagePoint(clientX: number, clientY: number): Point {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: clientX - r.left, y: clientY - r.top };
  }

  function hitTest(point: Point): "move" | HandleId | null {
    if (!rect) return null;
    const centers = handleCenters(rect);
    let closest: HandleId | null = null;
    let closestDist = HANDLE_HIT_RADIUS;
    for (const id of HANDLE_IDS) {
      const d = distance(point, centers[id]);
      if (d <= closestDist) {
        closest = id;
        closestDist = d;
      }
    }
    if (closest) return closest;
    if (point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h) {
      return "move";
    }
    return null;
  }

  function handlePointerDown(e: ReactPointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = stagePoint(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size === 1 && rect) {
      const mode = hitTest(p);
      dragInfo.current = mode ? { pointerId: e.pointerId, mode, startPointer: p, startRect: rect } : null;
    } else if (pointers.current.size === 2) {
      dragInfo.current = null;
      const pts = Array.from(pointers.current.values());
      lastPinchDist.current = distance(pts[0], pts[1]);
    }
  }

  function handlePointerMove(e: ReactPointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    const p = stagePoint(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size === 1 && dragInfo.current && dragInfo.current.pointerId === e.pointerId) {
      if (!imageRect || !stageSize) return;
      const bounds = boundsFromImageRect(imageRect, stageSize);
      const { mode, startPointer, startRect } = dragInfo.current;
      const dx = p.x - startPointer.x;
      const dy = p.y - startPointer.y;
      const nextRect = mode === "move" ? moveRect(startRect, dx, dy, bounds) : resizeRect(mode, startRect, dx, dy, bounds);
      setRect(nextRect);
    } else if (pointers.current.size === 2) {
      const pts = Array.from(pointers.current.values());
      const dist = distance(pts[0], pts[1]);
      const anchor = midpoint(pts[0], pts[1]);
      if (lastPinchDist.current) {
        applyZoom(scale * (dist / lastPinchDist.current), anchor);
      }
      lastPinchDist.current = dist;
    }
  }

  function handlePointerUp(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    if (dragInfo.current?.pointerId === e.pointerId) dragInfo.current = null;
    if (pointers.current.size < 2) lastPinchDist.current = null;
  }

  function handleSliderChange(value: number) {
    if (!stageSize) return;
    applyZoom(value, { x: stageSize.w / 2, y: stageSize.h / 2 });
  }

  function handleImageLoad() {
    const img = imgRef.current;
    if (!img) return;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  function handleConfirm() {
    if (!naturalSize || !stageSize || !rect) return;
    setError(null);

    const stageCx = stageSize.w / 2;
    const stageCy = stageSize.h / 2;
    const imgLeft = stageCx - (naturalSize.w * scale) / 2 + pan.x;
    const imgTop = stageCy - (naturalSize.h * scale) / 2 + pan.y;

    let cropX = (rect.x - imgLeft) / scale;
    let cropY = (rect.y - imgTop) / scale;
    let cropW = rect.w / scale;
    let cropH = rect.h / scale;

    cropX = clamp(cropX, 0, naturalSize.w - 1);
    cropY = clamp(cropY, 0, naturalSize.h - 1);
    cropW = clamp(cropW, 1, naturalSize.w - cropX);
    cropH = clamp(cropH, 1, naturalSize.h - cropY);

    const img = imgRef.current;
    if (!img) return;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(cropW);
    canvas.height = Math.round(cropH);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("캔버스 생성에 실패했어요");
      return;
    }
    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("이미지 자르기에 실패했어요");
          return;
        }
        onConfirm({
          croppedBlob: blob,
          manualCropPixels: { x: cropX, y: cropY, width: cropW, height: cropH },
          naturalWidth: naturalSize.w,
          naturalHeight: naturalSize.h,
        });
      },
      "image/jpeg",
      0.92
    );
  }

  const imgStyle =
    naturalSize && stageSize
      ? {
          width: `${naturalSize.w}px`,
          height: `${naturalSize.h}px`,
          transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: "center center",
        }
      : undefined;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <button type="button" onClick={onCancel} disabled={busy} className="text-sm disabled:opacity-40">
          취소
        </button>
        <p className="text-sm font-medium">사람 영역을 직접 지정해주세요</p>
        <button
          type="button"
          onClick={resetToDefault}
          disabled={busy || minScale === null}
          className="text-sm text-white/70 disabled:opacity-40"
        >
          초기화
        </button>
      </div>

      <div
        ref={stageRef}
        className="relative flex-1 touch-none overflow-hidden select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {objectUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={objectUrl}
            alt=""
            draggable={false}
            onLoad={handleImageLoad}
            className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
            style={imgStyle}
          />
        )}

        {rect && (
          <>
            {/* box-shadow로 사각형 바깥 전체를 반투명하게 덮는다 - 별도 오버레이
                div 4개를 계산해서 배치하지 않아도 rect가 움직일 때마다 자동으로
                따라온다. */}
            <div
              className="pointer-events-none absolute rounded-sm border-2 border-white"
              style={{
                left: rect.x,
                top: rect.y,
                width: rect.w,
                height: rect.h,
                boxShadow: "0 0 0 2000px rgba(0,0,0,0.55)",
              }}
            />
            {HANDLE_IDS.map((id) => {
              const centers = handleCenters(rect);
              const c = centers[id];
              return (
                <div
                  key={id}
                  className="pointer-events-none absolute rounded-full border-2 border-neutral-900 bg-white"
                  style={{
                    left: c.x - HANDLE_VISUAL_SIZE / 2,
                    top: c.y - HANDLE_VISUAL_SIZE / 2,
                    width: HANDLE_VISUAL_SIZE,
                    height: HANDLE_VISUAL_SIZE,
                  }}
                />
              );
            })}
          </>
        )}
      </div>

      <div className="space-y-3 px-6 py-4">
        {minScale !== null && (
          <input
            type="range"
            min={minScale}
            max={minScale * MAX_ZOOM_MULTIPLIER}
            step={(minScale * (MAX_ZOOM_MULTIPLIER - 1)) / 100}
            value={scale}
            onChange={(e) => handleSliderChange(Number(e.target.value))}
            className="w-full"
            aria-label="사진 확대/축소"
          />
        )}
        <p className="text-center text-xs text-white/60">
          사각형 안쪽을 드래그해 옮기고, 모서리·변을 드래그해 크기를 맞춰주세요. 두 손가락으로 사진을 확대할 수 있어요.
        </p>
        {error && <p className="text-center text-xs text-red-400">{error}</p>}
        <button
          type="button"
          onClick={handleConfirm}
          disabled={busy || !rect}
          className="w-full rounded-xl bg-white py-3 text-center text-sm font-medium text-neutral-900 disabled:opacity-50"
        >
          {busy ? "이 영역으로 생성 중…" : "이 영역으로 다시 생성"}
        </button>
      </div>
    </div>
  );
}
