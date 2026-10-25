"use client";

import { useEffect, useRef, useState } from "react";
import { getBlob, ref, uploadBytes } from "firebase/storage";
import { storage } from "@/lib/firebaseClient";
import { DEFAULT_DRESS_CATEGORIES, validateDressCategories, type DressCategory } from "@/lib/dressCategoryConfig";

// Account-owned settings use the existing authenticated Storage namespace.
// No look document is created, so settings never appear in photo queries.
function settingsRef(uid: string) {
  return ref(storage, `users/${uid}/looks/_settings/dress-categories.json`);
}


export function useDressCategories(uid: string | null) {
  const [state, setState] = useState<{ uid: string | null; categories: DressCategory[]; ready: boolean; error: string | null }>({
    uid: null, categories: DEFAULT_DRESS_CATEGORIES, ready: false, error: null,
  });
  const currentUid = useRef(uid);
  const saving = useRef(false);

  useEffect(() => {
    currentUid.current = uid;
    if (!uid) return;
    let cancelled = false;
    async function load() {
      let categories = DEFAULT_DRESS_CATEGORIES;
      try {
        const blob = await getBlob(settingsRef(uid!));
        categories = validateDressCategories(JSON.parse(await blob.text()));
      } catch (error) {
        if ((error as { code?: string }).code !== "storage/object-not-found") {
          if (!cancelled) setState({ uid, categories, ready: false, error: "카테고리를 불러오지 못했어요. 새로고침해 주세요." });
          return;
        }
      }
      if (!cancelled) setState({ uid, categories, ready: true, error: null });
    }
    void load();
    return () => { cancelled = true; };
  }, [uid]);

  async function saveDressCategories(next: DressCategory[]) {
    if (!uid || state.uid !== uid || !state.ready || saving.current) throw new Error("카테고리를 불러온 뒤 다시 시도해 주세요.");
    const categories = validateDressCategories(next);
    saving.current = true;
    try {
      await uploadBytes(settingsRef(uid), new Blob([JSON.stringify(categories)], { type: "application/json" }), { cacheControl: "no-store" });
      if (currentUid.current === uid) setState({ uid, categories, ready: true, error: null });
    } finally {
      saving.current = false;
    }
  }

  const active = state.uid === uid;
  return {
    dressCategories: active ? state.categories : DEFAULT_DRESS_CATEGORIES,
    categoriesReady: active && state.ready,
    categoriesError: active ? state.error : null,
    saveDressCategories,
  };
}
