"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebaseClient";
import { fetchUserLooks, type SavedLook } from "@/lib/lookStore";
import { AppContext } from "@/lib/AppContext";
import BottomNav from "@/components/BottomNav";
import LoginScreen from "@/components/LoginScreen";

const isDev = process.env.NODE_ENV !== "production";

function timestamp(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

/**
 * 로그인 게이트 + 전역 상태(로그인 유저, 저장된 룩 목록) 제공.
 * 로그인 전에는 LoginScreen만, 로그인 후에는 하단 내비게이션과 함께
 * 페이지 콘텐츠를 렌더링한다. STEP 1~3의 인증/조회 로직을 그대로 옮긴 것이며
 * 동작 자체는 바뀌지 않았다.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [devLog, setDevLog] = useState<string[]>([]);

  const [looks, setLooks] = useState<SavedLook[]>([]);
  const [looksLoading, setLooksLoading] = useState(false);

  function log(message: string) {
    if (!isDev) return;
    setDevLog((prev) => [...prev.slice(-49), `${timestamp()}  ${message}`]);
  }

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
      log(u ? `로그인 상태 (uid=${u.uid})` : "로그아웃 상태");
    });
    return unsubscribe;
  }, []);

  async function refreshLooks() {
    if (!user) {
      setLooks([]);
      return;
    }
    setLooksLoading(true);
    try {
      const data = await fetchUserLooks(user.uid);
      setLooks(data);
    } catch (err) {
      log(`저장된 룩 조회 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLooksLoading(false);
    }
  }

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 로그인 상태가 바뀔 때
       저장된 룩 목록을 동기화하는 의도적인 데이터 페칭 패턴 */
    if (user) {
      refreshLooks();
    } else {
      setLooks([]);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

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
    <AppContext.Provider value={{ user, looks, looksLoading, refreshLooks, signOutUser }}>
      <div className="min-h-dvh bg-white pb-24">{children}</div>
      <BottomNav />
    </AppContext.Provider>
  );
}
