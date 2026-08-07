"use client";

import { createContext, useContext } from "react";
import type { User } from "firebase/auth";
import type { DisplayLook } from "@/lib/useLocalFirstLooks";

export type AppContextValue = {
  user: User;
  looks: DisplayLook[];
  /** 백그라운드 Firestore 동기화 진행 중 여부 (초기 화면을 막지 않음) */
  syncing: boolean;
  /** 마지막 동기화가 실패했는지 (오프라인 등) - 캐시된 데이터는 계속 보여준다 */
  offline: boolean;
  refreshLooks: () => Promise<void>;
  signOutUser: () => void;
};

export const AppContext = createContext<AppContextValue | null>(null);

/** 로그인 이후 화면(AppShell 하위)에서만 호출 가능. */
export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error("useApp은 AppShell(로그인 이후 화면) 내부에서만 사용할 수 있습니다.");
  }
  return ctx;
}
