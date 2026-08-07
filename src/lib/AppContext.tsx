"use client";

import { createContext, useContext } from "react";
import type { User } from "firebase/auth";
import type { SavedLook } from "@/lib/lookStore";

export type AppContextValue = {
  user: User;
  looks: SavedLook[];
  looksLoading: boolean;
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
