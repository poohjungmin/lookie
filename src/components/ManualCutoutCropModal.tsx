"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// 정규화 캔버스(src/lib/cutout.ts NORMALIZE_CANVAS_*)와 같은 2:3 세로 비율을
// 써서, 여기서 대략 맞춘 영역이 자동 정규화 결과와 비슷한 구도로 나오게 한다.
const FRAME_ASPECT = 2 / 3; // width / height
const MAX_ZOOM_MULTIPLIER = 4; // "덮는 최소 배율" 대비 최대 확대 배수

type Point = { x: number; y: number };

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 원본 사진 위에 사람이 들어갈 대략적인 영역을 손가락으로 맞추는 크롭 UI.
 * 정확한 외곽선을 그리는 기능이 아니라 "사람이 존재하는 대략적인 영역"만
 * 지정하면 되므로, 무거운 크롭 라이브러리 없이 pinch/drag/slider만으로
 * 가볍게 구현한다. 두 손가락 pinch, 한 손가락 drag, 확대 슬라이더를 모두
 * 지원해 iPhone Safari/PWA 환경에서도 쓰기 쉽게 한다.
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
  onConfirm: (croppedBlob: Blob) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [error, setError] = useState<string | null>(null);

  // 활성 포인터(터치/마우스) 추적 - pinch 계산에 필요.
  const pointers = useRef<Map<number, Point>>(new Map());
  const lastPinchDist = useRef<number | null>(null);
  const lastPanPoint = useRef<Point | null>(null);

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

  const frameSize = useMemo(() => {
    if (!stageSize) return null;
    let frameHeight = stageSize.h * 0.72;
    let frameWidth = frameHeight * FRAME_ASPECT;
    if (frameWidth > stageSize.w * 0.92) {
      frameWidth = stageSize.w * 0.92;
      frameHeight = frameWidth / FRAME_ASPECT;
    }
    return { w: frameWidth, h: frameHeight };
  }, [stageSize]);

  // 이미지가 frame을 항상 완전히 덮도록 하는 최소 배율("cover" 배율).
  const minScale = useMemo(() => {
    if (!naturalSize || !frameSize) return null;
    return Math.max(frameSize.w / naturalSize.w, frameSize.h / naturalSize.h);
  }, [naturalSize, frameSize]);

  // 이미지/프레임 크기가 처음 정해지면 배율을 min에, pan을 중앙에 맞춘다.
  useEffect(() => {
    if (minScale === null) return;
    /* eslint-disable react-hooks/set-state-in-effect -- 이미지 로드(naturalSize)와
       스테이지 측정(stageSize)이라는 두 개의 독립적인 비동기 이벤트가 모두
       끝나야 minScale을 계산할 수 있어, 그 순간에 한 번만 초기 배율/위치로
       동기화해야 한다 (렌더 중에는 계산할 수 없는 파생 초기값). */
    setScale(minScale);
    setPan({ x: 0, y: 0 });
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- naturalSize/frameSize가 처음 정해질 때만 초기화
  }, [minScale !== null]);

  const clampPan = useCallback(
    (p: Point, s: number): Point => {
      if (!naturalSize || !frameSize || !stageSize) return p;
      const maxX = Math.max(0, (naturalSize.w * s - frameSize.w) / 2);
      const maxY = Math.max(0, (naturalSize.h * s - frameSize.h) / 2);
      return {
        x: Math.min(maxX, Math.max(-maxX, p.x)),
        y: Math.min(maxY, Math.max(-maxY, p.y)),
      };
    },
    [naturalSize, frameSize, stageSize]
  );

  // 현재 scale/pan을 클로저로 참조한다 - pinch/slider 이벤트가 발생한 그
  // 순간의 값 기준으로 앵커링해야 자연스러운 pinch-zoom이 되기 때문에,
  // 렌더마다 새로 만들어지는 이 함수가 항상 최신 state를 보게 둔다.
  const applyZoomAtPoint = useCallback(
    (newScaleRaw: number, anchor: Point) => {
      if (!stageSize || !naturalSize || minScale === null) return;
      const maxScale = minScale * MAX_ZOOM_MULTIPLIER;
      const newScale = Math.min(maxScale, Math.max(minScale, newScaleRaw));

      // anchor(포인터 위치, stage 좌표계) 아래의 이미지 내용이 확대/축소
      // 후에도 같은 화면 위치에 남도록 pan을 역산한다 (표준 pinch-zoom 앵커링).
      const stageCx = stageSize.w / 2;
      const stageCy = stageSize.h / 2;
      const imgLeftBefore = stageCx - (naturalSize.w * scale) / 2 + pan.x;
      const imgTopBefore = stageCy - (naturalSize.h * scale) / 2 + pan.y;
      const contentX = (anchor.x - imgLeftBefore) / scale;
      const contentY = (anchor.y - imgTopBefore) / scale;

      const imgLeftAfter = anchor.x - contentX * newScale;
      const imgTopAfter = anchor.y - contentY * newScale;
      const nextPan = {
        x: imgLeftAfter - stageCx + (naturalSize.w * newScale) / 2,
        y: imgTopAfter - stageCy + (naturalSize.h * newScale) / 2,
      };

      setScale(newScale);
      setPan(clampPan(nextPan, newScale));
    },
    [stageSize, naturalSize, minScale, scale, pan, clampPan]
  );

  function stagePoint(clientX: number, clientY: number): Point {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function handlePointerDown(e: ReactPointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, stagePoint(e.clientX, e.clientY));
    if (pointers.current.size === 1) {
      lastPanPoint.current = stagePoint(e.clientX, e.clientY);
    } else if (pointers.current.size === 2) {
      const pts = Array.from(pointers.current.values());
      lastPinchDist.current = distance(pts[0], pts[1]);
    }
  }

  function handlePointerMove(e: ReactPointerEvent) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, stagePoint(e.clientX, e.clientY));

    if (pointers.current.size === 1) {
      const p = stagePoint(e.clientX, e.clientY);
      const last = lastPanPoint.current;
      lastPanPoint.current = p;
      if (!last) return;
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      setPan((prev) => clampPan({ x: prev.x + dx, y: prev.y + dy }, scale));
    } else if (pointers.current.size === 2) {
      const pts = Array.from(pointers.current.values());
      const dist = distance(pts[0], pts[1]);
      const anchor = midpoint(pts[0], pts[1]);
      if (lastPinchDist.current) {
        const ratio = dist / lastPinchDist.current;
        applyZoomAtPoint(scale * ratio, anchor);
      }
      lastPinchDist.current = dist;
    }
  }

  function handlePointerUp(e: ReactPointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) lastPinchDist.current = null;
    if (pointers.current.size === 1) {
      const remaining = Array.from(pointers.current.values())[0];
      lastPanPoint.current = remaining ?? null;
    }
    if (pointers.current.size === 0) lastPanPoint.current = null;
  }

  function handleSliderChange(value: number) {
    if (!stageSize) return;
    // 슬라이더는 프레임 중앙을 기준으로 확대/축소한다.
    const anchor = { x: stageSize.w / 2, y: stageSize.h / 2 };
    applyZoomAtPoint(value, anchor);
  }

  function handleImageLoad() {
    const img = imgRef.current;
    if (!img) return;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }

  function handleConfirm() {
    if (!naturalSize || !frameSize || !stageSize) return;
    setError(null);

    const stageCx = stageSize.w / 2;
    const stageCy = stageSize.h / 2;
    const imgLeft = stageCx - (naturalSize.w * scale) / 2 + pan.x;
    const imgTop = stageCy - (naturalSize.h * scale) / 2 + pan.y;
    const frameLeft = (stageSize.w - frameSize.w) / 2;
    const frameTop = (stageSize.h - frameSize.h) / 2;

    // frame 좌표를 이미지 원본 픽셀 좌표로 역변환한다.
    let cropX = (frameLeft - imgLeft) / scale;
    let cropY = (frameTop - imgTop) / scale;
    let cropW = frameSize.w / scale;
    let cropH = frameSize.h / scale;

    // pan을 항상 clamp해두긴 하지만, 부동소수점 오차 방어용으로 한 번 더 clamp.
    cropX = Math.max(0, Math.min(naturalSize.w - 1, cropX));
    cropY = Math.max(0, Math.min(naturalSize.h - 1, cropY));
    cropW = Math.max(1, Math.min(naturalSize.w - cropX, cropW));
    cropH = Math.max(1, Math.min(naturalSize.h - cropY, cropH));

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
        onConfirm(blob);
      },
      "image/jpeg",
      0.92
    );
  }

  const frameStyle = frameSize
    ? {
        width: `${frameSize.w}px`,
        height: `${frameSize.h}px`,
        boxShadow: "0 0 0 2000px rgba(0,0,0,0.55)",
      }
    : undefined;

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
        <p className="text-sm font-medium">사람이 들어갈 영역을 맞춰주세요</p>
        <div className="w-8" />
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
            className="absolute left-1/2 top-1/2 max-w-none"
            style={imgStyle}
          />
        )}
        {frameSize && (
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-white/90"
            style={frameStyle}
          />
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
            aria-label="확대/축소"
          />
        )}
        <p className="text-center text-xs text-white/60">
          두 손가락으로 확대/축소하거나 사진을 드래그해서 머리부터 발까지 프레임 안에 넣어주세요.
        </p>
        {error && <p className="text-center text-xs text-red-400">{error}</p>}
        <button
          type="button"
          onClick={handleConfirm}
          disabled={busy || !naturalSize}
          className="w-full rounded-xl bg-white py-3 text-center text-sm font-medium text-neutral-900 disabled:opacity-50"
        >
          {busy ? "이 영역으로 생성 중…" : "이 영역으로 다시 생성"}
        </button>
      </div>
    </div>
  );
}
