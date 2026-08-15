"use client";

import { useState } from "react";
import { useApp } from "@/lib/AppContext";
import {
  generateCutoutWithDiagnostics,
  CURRENT_CUTOUT_VERSION,
  type CutoutDiagnosticStep,
} from "@/lib/cutout";
import {
  uploadLookCutout,
  uploadLookCutoutThumbnail,
  updateLookCutoutFields,
} from "@/lib/lookStore";
import { storage } from "@/lib/firebaseClient";
import { downloadOriginalWithFallbacks } from "@/lib/cutoutDownload";
import { withTimeout } from "@/lib/timeout";
import { getPersonalCorrectionProfile } from "@/lib/personalCropHeuristic";

/** download URL(https://firebasestorage.googleapis.com/v0/b/{bucket}/o/...)에서 버킷 이름만 뽑아낸다. */
function extractBucketFromUrl(url: string): string | null {
  const match = url.match(/\/b\/([^/]+)\/o\//);
  return match ? match[1] : null;
}

/*
 * 개발용 도구 — Storage에 남아있는 original 이미지로 cutout/cutout-thumb를
 * 최신 정규화 알고리즘으로 다시 만들어 덮어쓰는 일괄 재처리 도구.
 * cutoutVersion이 CURRENT_CUTOUT_VERSION보다 낮은(또는 아예 없는) 룩만
 * 대상으로 삼고, 이미 최신인 룩은 건너뛴다.
 *
 * 접근 제어: 이 페이지도 다른 모든 페이지와 마찬가지로 루트 레이아웃의
 * AppShell(Google 로그인 게이트) 안에서만 렌더링된다 - useApp()은 로그인
 * 전에는 아예 호출될 수 없다. 여기서 쓰는 user.uid는 항상 "현재 로그인한
 * 본인"이고, looks도 그 uid로만 조회된 목록이라 다른 사용자의
 * users/{uid}/looks/*  데이터에는 애초에 접근할 수 없다. Firestore/Storage
 * 보안 규칙도 동일하게 request.auth.uid == uid만 허용해 이중으로 막는다.
 *
 * 절대 건드리지 않는 것: Firestore 문서 삭제, lookId, createdAt, 날씨,
 * EXIF(위경도/촬영일) - 오직 Storage의 cutout/cutout-thumb 파일과 Firestore의
 * cutoutUrl/cutoutThumbnailUrl/(관련 storagePath)/cutoutVersion/updatedAt만 바뀐다.
 *
 * 마이그레이션이 끝나면 이 상수를 false로 바꿔 production에서 다시
 * 숨긴다 (라우트 자체를 지우지 않아도 즉시 비활성화 가능).
 */
const ENABLE_CUTOUT_MIGRATION = true;

// --- 공통 에러 진단 ---------------------------------------------------------

type StepError = {
  step: string;
  name: string;
  message: string;
  code?: string;
  httpStatus?: number;
  /** Storage path 등 - Firebase 토큰 같은 민감정보는 절대 포함하지 않는다. */
  target?: string;
};

function describeError(step: string, err: unknown, target?: string): StepError {
  const e = err as { name?: string; message?: string; code?: string; status?: number };
  return {
    step,
    name: e?.name ?? "UnknownError",
    message: e?.message ?? String(err),
    code: e?.code,
    httpStatus: typeof e?.status === "number" ? e.status : undefined,
    target,
  };
}

const CUTOUT_TIMEOUT_MS = 60000; // 첫 실행 시 모델을 CDN에서 받아야 할 수 있어 넉넉히
const UPLOAD_TIMEOUT_MS = 20000;
const FIRESTORE_TIMEOUT_MS = 15000;

function StepErrorView({ error }: { error: StepError }) {
  return (
    <div className="mt-1 rounded-lg bg-red-50 p-2 text-[11px] leading-relaxed text-red-700">
      <p className="font-medium">실패 단계: {error.step}</p>
      <p>name: {error.name}</p>
      <p className="break-all">message: {error.message}</p>
      {error.code && <p>code: {error.code}</p>}
      {error.httpStatus !== undefined && <p>HTTP status: {error.httpStatus}</p>}
      {error.target && <p className="break-all">대상: {error.target}</p>}
    </div>
  );
}

// --- 1장 테스트(진단 모드) --------------------------------------------------

type DiagStepKey =
  | "doc"
  | "path"
  | "download"
  | "blob"
  | "cutout"
  | "upload-cutout"
  | "upload-thumb"
  | "firestore";

const DIAG_STEP_LABELS: Record<DiagStepKey, string> = {
  doc: "1. Firestore 문서 확인",
  path: "2. original 경로 확인",
  download: "3. Storage 원본 다운로드",
  blob: "4. Blob 생성 확인",
  cutout: "5~7. 누끼 모델 로드 · 처리 · 정규화",
  "upload-cutout": "8. cutout 업로드",
  "upload-thumb": "9. cutout-thumb 업로드",
  firestore: "10. Firestore 업데이트",
};

const DIAG_STEP_ORDER: DiagStepKey[] = [
  "doc",
  "path",
  "download",
  "blob",
  "cutout",
  "upload-cutout",
  "upload-thumb",
  "firestore",
];

type DiagStepState = { status: "pending" | "running" | "ok" | "fail"; error?: StepError; note?: string };

// --- 일괄 처리 항목 ----------------------------------------------------------

type ItemStatus = "pending" | "running" | "done" | "skipped" | "error";

type Item = {
  id: string;
  imageUrl: string;
  status: ItemStatus;
  currentStep?: string;
  error?: StepError;
};

export default function CutoutMigratePage() {
  const { user, looks, refreshLooks } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const [finished, setFinished] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [diagSteps, setDiagSteps] = useState<Record<DiagStepKey, DiagStepState> | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);

  const pendingLooks = looks.filter((l) => (l.cutoutVersion ?? 0) < CURRENT_CUTOUT_VERSION);

  function updateItem(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  function updateDiagStep(key: DiagStepKey, patch: Partial<DiagStepState>) {
    setDiagSteps((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: { ...prev[key], ...patch } };
    });
  }

  // 전체를 돌리기 전에 한 장만으로 각 단계를 검증하는 진단 모드.
  // 요청된 10단계에 맞춰 하나씩 try/catch로 나누고, 실패한 단계에서 멈춘다.
  async function runDiagnosticOnFirst() {
    const target = pendingLooks[0];
    if (!target || diagRunning) return;

    const initial = Object.fromEntries(
      DIAG_STEP_ORDER.map((k) => [k, { status: "pending" as const }])
    ) as Record<DiagStepKey, DiagStepState>;
    setDiagSteps(initial);
    setDiagRunning(true);

    // 1. Firestore 문서 확인 - 이미 looks 목록에 있으므로 그 자체가 성공.
    updateDiagStep("doc", { status: "ok", note: `lookId=${target.id}` });

    // 2. original 경로 확인 - SDK가 지금 연결된 버킷과, imageUrl에 실제로
    // 박혀 있는(업로드 당시의) 버킷이 다르면 getBlob()이 엉뚱한 곳을 찾다가
    // 멈추거나 실패할 수 있다. 여기서 미리 비교해 눈으로 확인한다.
    updateDiagStep("path", { status: "running" });
    const storagePath = target.storagePath || `users/${user.uid}/looks/${target.id}/original`;
    if (!target.imageUrl && !target.storagePath) {
      updateDiagStep("path", {
        status: "fail",
        error: describeError("경로 확인", new Error("imageUrl과 storagePath가 모두 비어 있음")),
      });
      setDiagRunning(false);
      return;
    }
    const sdkBucket = storage.app.options.storageBucket ?? "(설정 없음)";
    const urlBucket = target.imageUrl ? extractBucketFromUrl(target.imageUrl) : null;
    const bucketNote =
      urlBucket && urlBucket !== sdkBucket
        ? `⚠ 버킷 불일치! SDK=${sdkBucket} / imageUrl=${urlBucket}`
        : `버킷 일치: ${sdkBucket}`;
    updateDiagStep("path", {
      status: "ok",
      note: `storagePath=${storagePath} · ${bucketNote}`,
    });

    // 3. Storage 원본 다운로드 - 버킷은 일치하는 걸 확인했으니, 이번엔
    // SDK getBlob() / 공개 download URL fetch() / <img>+캔버스 세 가지를
    // "동시에" 시도해서 같은 순간·같은 네트워크 조건에서 어느 쪽이 실제로
    // 되는지 직접 비교한다.
    updateDiagStep("download", { status: "running" });
    let originalBlob: Blob;
    try {
      const dl = await downloadOriginalWithFallbacks(
        user.uid,
        target.id,
        target.storagePath,
        target.imageUrl
      );
      originalBlob = dl.blob;
      updateDiagStep("download", {
        status: "ok",
        note: `${dl.notes.join("\n")}\n→ 이번엔 ${dl.source} 결과를 사용`,
      });
    } catch (err) {
      updateDiagStep("download", {
        status: "fail",
        error: describeError("Storage 원본 다운로드 (세 방식 모두 실패)", err, storagePath),
      });
      setDiagRunning(false);
      return;
    }

    // 4. Blob 생성 확인
    updateDiagStep("blob", { status: "running" });
    if (!originalBlob || originalBlob.size === 0) {
      updateDiagStep("blob", {
        status: "fail",
        error: describeError("Blob 생성 확인", new Error("다운로드된 Blob 크기가 0")),
      });
      setDiagRunning(false);
      return;
    }
    updateDiagStep("blob", { status: "ok", note: `${(originalBlob.size / 1024).toFixed(0)}KB, type=${originalBlob.type}` });

    // 5~7. 누끼 모델 로드 / 세그멘테이션 / 정규화
    updateDiagStep("cutout", { status: "running" });
    let diag;
    try {
      const personalCorrections = await getPersonalCorrectionProfile(user.uid);
      diag = await withTimeout(
        generateCutoutWithDiagnostics(originalBlob, personalCorrections),
        CUTOUT_TIMEOUT_MS,
        "누끼 모델 로드/세그멘테이션/정규화"
      );
    } catch (err) {
      updateDiagStep("cutout", { status: "fail", error: describeError("누끼 생성(타임아웃)", err) });
      setDiagRunning(false);
      return;
    }
    if (!diag.ok) {
      const stepLabel: Record<CutoutDiagnosticStep, string> = {
        "model-or-segment": "누끼 모델 로드/세그멘테이션 (CDN에서 모델을 못 받았거나 추론 실패)",
        "normalize-or-resize": "정규화/리사이즈 (캔버스 처리 실패)",
      };
      const err = describeError(stepLabel[diag.step], diag.error);
      updateDiagStep("cutout", {
        status: "fail",
        error: err,
        note: diag.lastProgressPhase ? `마지막 진행 단계: ${diag.lastProgressPhase}` : undefined,
      });
      setDiagRunning(false);
      return;
    }
    updateDiagStep("cutout", {
      status: "ok",
      note: diag.usedNormalization ? "정규화 성공" : "정규화 실패(폴백) - 그래도 누끼는 생성됨",
    });

    // 8. cutout 업로드
    updateDiagStep("upload-cutout", { status: "running" });
    let cutoutUrl: string;
    let cutoutStoragePath: string;
    try {
      const r = await withTimeout(
        uploadLookCutout(user.uid, target.id, diag.result.detailBlob),
        UPLOAD_TIMEOUT_MS,
        "cutout 업로드"
      );
      cutoutUrl = r.cutoutUrl;
      cutoutStoragePath = r.cutoutStoragePath;
    } catch (err) {
      updateDiagStep("upload-cutout", {
        status: "fail",
        error: describeError("cutout 업로드", err, `users/${user.uid}/looks/${target.id}/cutout`),
      });
      setDiagRunning(false);
      return;
    }
    updateDiagStep("upload-cutout", { status: "ok" });

    // 9. cutout-thumb 업로드
    updateDiagStep("upload-thumb", { status: "running" });
    let cutoutThumbnailUrl: string;
    let cutoutThumbnailStoragePath: string;
    try {
      const r = await withTimeout(
        uploadLookCutoutThumbnail(user.uid, target.id, diag.result.thumbBlob),
        UPLOAD_TIMEOUT_MS,
        "cutout-thumb 업로드"
      );
      cutoutThumbnailUrl = r.cutoutThumbnailUrl;
      cutoutThumbnailStoragePath = r.cutoutThumbnailStoragePath;
    } catch (err) {
      updateDiagStep("upload-thumb", {
        status: "fail",
        error: describeError("cutout-thumb 업로드", err, `users/${user.uid}/looks/${target.id}/cutout-thumb`),
      });
      setDiagRunning(false);
      return;
    }
    updateDiagStep("upload-thumb", { status: "ok" });

    // 10. Firestore 업데이트
    updateDiagStep("firestore", { status: "running" });
    try {
      await withTimeout(
        updateLookCutoutFields(user.uid, target.id, {
          cutoutUrl,
          cutoutStoragePath,
          cutoutThumbnailUrl,
          cutoutThumbnailStoragePath,
          cutoutVersion: CURRENT_CUTOUT_VERSION,
          lastAutoCropRatio: diag.result.autoCrop?.bboxRatio ?? null,
        }),
        FIRESTORE_TIMEOUT_MS,
        "Firestore 업데이트"
      );
    } catch (err) {
      updateDiagStep("firestore", {
        status: "fail",
        error: describeError("Firestore 업데이트", err, `users/${user.uid}/looks/${target.id}`),
      });
      setDiagRunning(false);
      return;
    }
    updateDiagStep("firestore", { status: "ok" });

    setDiagRunning(false);
    await refreshLooks();
  }

  async function start() {
    setConfirmOpen(false);
    if (running) return;
    const targets = pendingLooks;
    if (targets.length === 0) return;

    setItems(targets.map((look) => ({ id: look.id, imageUrl: look.imageUrl, status: "pending" })));
    setProcessedCount(0);
    setFinished(false);
    setRunning(true);

    // 배치 전체에서 한 번만 읽는다 (내부 캐시) - 항목마다 다시 조회하지 않는다.
    const personalCorrections = await getPersonalCorrectionProfile(user.uid);

    for (const look of targets) {
      try {
        updateItem(look.id, { status: "running", currentStep: "Storage 원본 다운로드" });
        const { blob: originalBlob } = await downloadOriginalWithFallbacks(
          user.uid,
          look.id,
          look.storagePath,
          look.imageUrl
        );
        if (!originalBlob || originalBlob.size === 0) {
          throw new Error("다운로드된 Blob 크기가 0");
        }

        updateItem(look.id, { currentStep: "누끼 모델 로드/처리/정규화" });
        const diag = await withTimeout(
          generateCutoutWithDiagnostics(originalBlob, personalCorrections),
          CUTOUT_TIMEOUT_MS,
          "누끼 모델 로드/세그멘테이션/정규화"
        );
        if (!diag.ok) {
          updateItem(look.id, {
            status: "skipped",
            error: describeError(
              diag.step === "model-or-segment" ? "누끼 모델/세그멘테이션" : "정규화/리사이즈",
              diag.error
            ),
          });
          setProcessedCount((n) => n + 1);
          continue;
        }

        updateItem(look.id, { currentStep: "cutout 업로드" });
        const [detail, thumb] = await Promise.all([
          withTimeout(uploadLookCutout(user.uid, look.id, diag.result.detailBlob), UPLOAD_TIMEOUT_MS, "cutout 업로드"),
          withTimeout(
            uploadLookCutoutThumbnail(user.uid, look.id, diag.result.thumbBlob),
            UPLOAD_TIMEOUT_MS,
            "cutout-thumb 업로드"
          ),
        ]);

        updateItem(look.id, { currentStep: "Firestore 업데이트" });
        await withTimeout(
          updateLookCutoutFields(user.uid, look.id, {
            cutoutUrl: detail.cutoutUrl,
            cutoutStoragePath: detail.cutoutStoragePath,
            cutoutThumbnailUrl: thumb.cutoutThumbnailUrl,
            cutoutThumbnailStoragePath: thumb.cutoutThumbnailStoragePath,
            cutoutVersion: CURRENT_CUTOUT_VERSION,
            lastAutoCropRatio: diag.result.autoCrop?.bboxRatio ?? null,
          }),
          FIRESTORE_TIMEOUT_MS,
          "Firestore 업데이트"
        );

        updateItem(look.id, { status: "done" });
      } catch (err) {
        updateItem(look.id, {
          status: "error",
          error: describeError("원본 다운로드 또는 업로드", err, look.storagePath || undefined),
        });
      } finally {
        setProcessedCount((n) => n + 1);
      }
    }

    setRunning(false);
    setFinished(true);
    await refreshLooks();
  }

  const doneCount = items.filter((i) => i.status === "done").length;
  const skippedCount = items.filter((i) => i.status === "skipped").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  if (!ENABLE_CUTOUT_MIGRATION) {
    return (
      <div className="mx-auto max-w-2xl px-5 pt-16 text-center sm:px-6">
        <p className="text-sm text-neutral-400">
          이 도구는 현재 비활성화되어 있습니다.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-5 pb-16 pt-10 sm:px-6">
      <header className="mb-6">
        <p className="text-xs font-medium tracking-wide text-amber-600">
          개발용 도구 — 기존 누끼 재생성
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          누끼 다시 생성
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          현재 알고리즘 버전 {CURRENT_CUTOUT_VERSION}보다 낮은(또는 아예 없는)
          룩 {pendingLooks.length}개를 원본 이미지로 다시 처리합니다. 본인(
          {user.email ?? user.uid})의 룩만 대상입니다.
        </p>
      </header>

      {/* 진단 모드 - 전체를 돌리기 전에 한 장으로 각 단계를 확인 */}
      <section className="rounded-2xl border border-neutral-200 p-4">
        <p className="text-sm font-medium text-neutral-800">1장 테스트 (진단 모드)</p>
        <p className="mt-1 text-xs text-neutral-500">
          대상 중 첫 번째 룩 하나만 10단계로 나눠 실행하고, 어느 단계에서
          막히는지 정확히 보여줍니다. 전체 재생성 전에 먼저 이걸로 확인하세요.
        </p>
        <button
          type="button"
          onClick={runDiagnosticOnFirst}
          disabled={diagRunning || pendingLooks.length === 0}
          className="mt-3 w-full rounded-xl border border-neutral-300 py-2.5 text-center text-sm font-medium text-neutral-800 disabled:opacity-40"
        >
          {diagRunning ? "진단 중…" : "1장 재생성 테스트"}
        </button>

        {diagSteps && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {DIAG_STEP_ORDER.map((key) => {
              const s = diagSteps[key];
              return (
                <li key={key} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <span>
                      {s.status === "pending" && "⬜"}
                      {s.status === "running" && "⏳"}
                      {s.status === "ok" && "✅"}
                      {s.status === "fail" && "❌"}
                    </span>
                    <span
                      className={
                        s.status === "fail"
                          ? "text-red-700"
                          : s.status === "ok"
                          ? "text-neutral-700"
                          : "text-neutral-400"
                      }
                    >
                      {DIAG_STEP_LABELS[key]}
                    </span>
                  </div>
                  {s.note && (
                    <p className="ml-5 whitespace-pre-line text-[11px] text-neutral-400">{s.note}</p>
                  )}
                  {s.error && (
                    <div className="ml-5">
                      <StepErrorView error={s.error} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={running || pendingLooks.length === 0}
        className="mt-6 w-full rounded-2xl bg-neutral-900 py-4 text-center text-sm font-medium text-white disabled:bg-neutral-300"
      >
        {running
          ? `${processedCount} / ${items.length} 진행중…`
          : pendingLooks.length === 0
          ? "재생성이 필요한 룩 없음"
          : `🔄 누끼 다시 생성 (${pendingLooks.length}개)`}
      </button>

      {finished && (
        <p className="mt-4 text-center text-sm font-medium text-neutral-700">
          완료 - 성공 {doneCount}장 · 건너뜀 {skippedCount}장 · 실패 {errorCount}장
        </p>
      )}

      {!finished && items.length > 0 && (
        <p className="mt-4 text-center text-xs text-neutral-500">
          {items.length}개 중 {processedCount}개 처리됨 (성공 {doneCount} · 건너뜀 {skippedCount} · 실패 {errorCount})
        </p>
      )}

      <ul className="mt-6 flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-start gap-3 rounded-xl border border-neutral-100 p-2"
          >
            <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-neutral-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
            </div>
            <div className="min-w-0 flex-1 text-xs">
              <p className="truncate text-neutral-400">{item.id}</p>
              <p
                className={
                  item.status === "error"
                    ? "text-red-600"
                    : item.status === "done"
                    ? "text-neutral-700"
                    : "text-neutral-400"
                }
              >
                {item.status === "pending" && "대기 중"}
                {item.status === "running" && `${item.currentStep ?? "처리 중"}…`}
                {item.status === "done" && "완료"}
                {item.status === "skipped" && "누끼 생성 건너뜀"}
                {item.status === "error" && "실패"}
              </p>
              {item.error && <StepErrorView error={item.error} />}
            </div>
          </li>
        ))}
      </ul>

      {/* 실수로 바로 실행되지 않도록, 버튼을 눌러도 곧바로 시작하지 않고
          한 번 더 확인한다. */}
      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center">
          <div className="w-full max-w-sm rounded-t-3xl bg-white p-6 sm:rounded-3xl">
            <p className="text-base font-semibold text-neutral-900">
              누끼를 다시 생성할까요?
            </p>
            <p className="mt-2 text-sm leading-relaxed text-neutral-500">
              기존 룩의 누끼 이미지를 최신 알고리즘으로 다시 생성합니다.
              원본 사진과 날짜·날씨 정보는 변경되지 않습니다.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="flex-1 rounded-2xl border border-neutral-200 py-3 text-sm font-medium text-neutral-700"
              >
                취소
              </button>
              <button
                type="button"
                onClick={start}
                className="flex-1 rounded-2xl bg-neutral-900 py-3 text-sm font-medium text-white"
              >
                시작
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
