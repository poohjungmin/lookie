"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebaseClient";
import { useLocalFirstLooks } from "@/lib/useLocalFirstLooks";
import { AppContext } from "@/lib/AppContext";
import BottomNav from "@/components/BottomNav";
import LoginScreen from "@/components/LoginScreen";

const isDev = process.env.NODE_ENV !== "production";

function timestamp(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/**
 * 로그인 게이트 + 전역 상태(로그인 유저, 로컬 캐시 우선으로 불러오는 룩 목록) 제공.
 * 로그인 전에는 LoginScreen만, 로그인 후에는 하단 내비게이션과 함께
 * 페이지 콘텐츠를 렌더링한다.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [devLog, setDevLog] = useState<string[]>([]);

  const log = useCallback((message: string) => {
    if (!isDev) return;
    setDevLog((prev) => [...prev.slice(-49), `${timestamp()}  ${message}`]);
  }, []);

  const { looks, syncing, offline, refresh, refreshSingleLook, patchLookWeather, deleteLook } =
    useLocalFirstLooks(user ? user.uid : null, log);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
      log(u ? `로그인 상태 (uid=${u.uid})` : "로그아웃 상태");
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 팝업 방식을 우선 사용한다 (redirect 방식은 최신 Chrome의 서드파티 저장소
  // 분리 정책 때문에 로그인 후 첫 화면으로 되돌아가는 문제가 실측 확인됨).
  // 팝업이 막히는 환경에서만 redirect로 폴백한다.
  async function handleGoogleSignIn() {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
      log("signInWithPopup 성공");
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "unknown";
      const message = err instanceof Error ? err.message : String(err);
      log(`signInWithPopup 실패: [${code}] ${message}`);

      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        return;
      }
      if (
        code === "auth/popup-blocked" ||
        code === "auth/operation-not-supported-in-this-environment"
      ) {
        log("팝업 사용 불가 환경 - redirect 방식으로 재시도");
        signInWithRedirect(auth, googleProvider).catch((redirectErr) => {
          setAuthError(
            `Google 로그인 시작 실패: ${
              redirectErr instanceof Error ? redirectErr.message : String(redirectErr)
            }`
          );
        });
        return;
      }
      setAuthError(`Google 로그인 실패 (${code}): ${message}`);
    }
  }

  function signOutUser() {
    signOut(auth).catch((err) => {
      log(`로그아웃 실패: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // 로그인 상태를 아직 모르는 동안은 아무 화면도 확정하지 않는다
  // (로그인 전 화면이 잠깐 보였다가 사라지는 깜빡임 방지).
  if (authLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-white">
        <p className="text-sm text-neutral-400">불러오는 중…</p>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onSignIn={handleGoogleSignIn} error={authError} devLog={devLog} />;
  }

  return (
    <AppContext.Provider
      value={{
        user,
        looks,
        syncing,
        offline,
        refreshLooks: refresh,
        refreshSingleLook,
        patchLookWeather,
        deleteLook,
        signOutUser,
      }}
    >
      <div className="min-h-dvh bg-white pb-24">
        {/* 캐시된 데이터는 보여주되, 방금 동기화가 실패했다면(오프라인 등) 알려준다 */}
        {offline && (
          <div className="bg-amber-50 px-4 py-1.5 text-center text-[11px] text-amber-700">
            오프라인 상태예요 - 마지막으로 저장된 룩을 보여드리고 있어요
          </div>
        )}
        {children}
      </div>
      {/* DEVELOPMENT ONLY - 로컬 캐시/동기화 상태를 콘솔 없이 확인하기 위한 표시 */}
      {isDev && (
        <div className="fixed right-2 top-2 z-30 rounded-lg bg-neutral-900/90 px-2 py-1 text-[10px] text-white">
          {syncing ? "동기화 중…" : offline ? "오프라인" : `동기화됨 · ${looks.length}개`}
        </div>
      )}
      <BottomNav />
    </AppContext.Provider>
  );
}
