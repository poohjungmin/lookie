"use client";

export default function LoginScreen({
  onSignIn,
  error,
  devLog = [],
}: {
  onSignIn: () => void;
  error: string | null;
  devLog?: string[];
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-white px-6 text-center">
      <p className="text-sm font-medium tracking-wide text-neutral-400">LOOKIE</p>
      <h1 className="mt-2 text-2xl font-semibold text-neutral-900">룩기</h1>
      <p className="mt-3 max-w-xs text-sm leading-relaxed text-neutral-500">
        사진첩 속 거울셀카를 자동으로 정리해, 그날의 날씨와 함께 보여주는
        개인 룩 아카이브
      </p>
      <button
        type="button"
        onClick={onSignIn}
        className="mt-8 w-full max-w-xs rounded-2xl bg-neutral-900 py-4 text-sm font-medium text-white active:bg-neutral-700"
      >
        Google로 시작하기
      </button>
      {error && <p className="mt-4 max-w-xs text-xs text-red-600">{error}</p>}

      {/* DEVELOPMENT ONLY — 로그인은 콘솔 없이 디버깅하기 어려운 리다이렉트/팝업
          흐름이라, 개발 모드에서만 최근 로그를 화면에 남겨 둔다. */}
      {devLog.length > 0 && (
        <details className="mt-6 w-full max-w-xs text-left">
          <summary className="cursor-pointer text-xs text-neutral-400">
            개발자 로그 ({devLog.length})
          </summary>
          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-neutral-900 p-2 font-mono text-[10px] leading-relaxed text-neutral-100">
            {devLog.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
