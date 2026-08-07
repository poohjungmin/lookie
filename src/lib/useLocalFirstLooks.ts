"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Timestamp } from "firebase/firestore";
import { fetchUserLooks, type SavedLook } from "@/lib/lookStore";
import {
  cacheKeyOf,
  deleteCachedLook,
  getCachedLooks,
  putCachedLook,
  type CachedLook,
} from "@/lib/lookCache";

/** 화면에 그대로 쓰는 SavedLook + 목록/캘린더/홈에서 쓸 표시용 썸네일 소스. */
export type DisplayLook = SavedLook & { thumbSrc: string };

function updatedAtMs(look: SavedLook): number {
  return look.updatedAt?.toMillis?.() ?? look.createdAt?.toMillis?.() ?? 0;
}

function savedLookToCacheEntry(uid: string, look: SavedLook): CachedLook {
  return {
    cacheKey: cacheKeyOf(uid, look.id),
    uid,
    lookId: look.id,
    imageUrl: look.imageUrl,
    thumbnailUrl: look.thumbnailUrl,
    takenAtMs: look.takenAt ? look.takenAt.toMillis() : null,
    latitude: look.latitude,
    longitude: look.longitude,
    weatherStatus: look.weatherStatus,
    weather: look.weather,
    updatedAtMs: updatedAtMs(look),
    thumbBlob: null,
    thumbType: null,
    cachedAt: Date.now(),
  };
}

function cacheEntryToDisplayLook(entry: CachedLook, thumbSrc: string): DisplayLook {
  return {
    id: entry.lookId,
    imageUrl: entry.imageUrl,
    storagePath: "",
    thumbnailUrl: entry.thumbnailUrl,
    thumbnailStoragePath: null,
    originalFileName: "",
    takenAt: entry.takenAtMs !== null ? Timestamp.fromMillis(entry.takenAtMs) : null,
    latitude: entry.latitude,
    longitude: entry.longitude,
    weather: entry.weather,
    weatherStatus: entry.weatherStatus,
    category: null,
    dressLevel: null,
    aiAnalysis: null,
    fingerprint: entry.lookId,
    createdAt: Timestamp.fromMillis(entry.updatedAtMs) as SavedLook["createdAt"],
    updatedAt: Timestamp.fromMillis(entry.updatedAtMs) as SavedLook["updatedAt"],
    thumbSrc,
  };
}

function sortByTakenAtDesc(list: DisplayLook[]): DisplayLook[] {
  return [...list].sort((a, b) => {
    const at = a.takenAt ? a.takenAt.toMillis() : 0;
    const bt = b.takenAt ? b.takenAt.toMillis() : 0;
    return bt - at;
  });
}

/**
 * Local-first 룩 목록 로딩.
 *
 * 1) uid가 정해지면 IndexedDB 캐시를 즉시 읽어 화면부터 채운다 (네트워크 대기 없음).
 * 2) 동시에 백그라운드로 Firestore와 동기화한다: updatedAt이 캐시보다 새로운
 *    항목만 썸네일을 다시 받고, 그대로인 항목은 재다운로드하지 않는다.
 * 3) Firestore 접근이 실패하면(오프라인 등) 이미 화면에 있는 캐시 데이터를
 *    그대로 유지하고 offline 플래그만 세운다 - 화면을 비우지 않는다.
 */
export function useLocalFirstLooks(uid: string | null, log: (message: string) => void) {
  const [looks, setLooks] = useState<DisplayLook[]>([]);
  const [initialSource, setInitialSource] = useState<"cache" | "empty" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [offline, setOffline] = useState(false);

  const objectUrls = useRef<Map<string, string>>(new Map());
  const cacheMap = useRef<Map<string, CachedLook>>(new Map());

  const getThumbSrc = useCallback((entry: CachedLook): string => {
    if (entry.thumbBlob) {
      let url = objectUrls.current.get(entry.lookId);
      if (!url) {
        url = URL.createObjectURL(entry.thumbBlob);
        objectUrls.current.set(entry.lookId, url);
      }
      return url;
    }
    return entry.thumbnailUrl ?? entry.imageUrl;
  }, []);

  const publishFromCacheMap = useCallback(() => {
    const display = sortByTakenAtDesc(
      Array.from(cacheMap.current.values()).map((e) => cacheEntryToDisplayLook(e, getThumbSrc(e)))
    );
    setLooks(display);
  }, [getThumbSrc]);

  // uid가 바뀔 때(로그인/로그아웃/계정 전환)마다 이전 계정의 상태를 완전히 비운다.
  // -> 다른 계정의 캐시가 화면에 잠깐이라도 비치지 않도록 한다.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 계정이 바뀔 때 이전
       계정의 상태를 즉시 비우는 의도적인 초기화 (다른 계정 캐시 노출 방지) */
    for (const url of objectUrls.current.values()) URL.revokeObjectURL(url);
    objectUrls.current.clear();
    cacheMap.current.clear();
    setLooks([]);
    setInitialSource(null);
    setSyncing(false);
    setOffline(false);
    /* eslint-enable react-hooks/set-state-in-effect */

    if (!uid) return;

    let cancelled = false;
    const startedAt = performance.now();

    (async () => {
      const cached = await getCachedLooks(uid);
      if (cancelled) return;
      for (const entry of cached) cacheMap.current.set(entry.lookId, entry);
      publishFromCacheMap();
      setInitialSource(cached.length > 0 ? "cache" : "empty");
      const elapsed = Math.round(performance.now() - startedAt);
      log(`[local-first] IndexedDB 캐시 ${cached.length}개로 초기 표시 (${elapsed}ms)`);
      if (process.env.NODE_ENV !== "production") {
        console.log(`[lookie] initial paint from cache: ${cached.length} looks in ${elapsed}ms`);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const syncNow = useCallback(async () => {
    if (!uid) return;
    setSyncing(true);
    const startedAt = performance.now();
    try {
      const remote = await fetchUserLooks(uid);
      setOffline(false);

      const remoteIds = new Set(remote.map((l) => l.id));

      // Firestore에서 사라진(삭제된) 룩은 캐시에서도 지운다.
      for (const lookId of Array.from(cacheMap.current.keys())) {
        if (!remoteIds.has(lookId)) {
          cacheMap.current.delete(lookId);
          const url = objectUrls.current.get(lookId);
          if (url) {
            URL.revokeObjectURL(url);
            objectUrls.current.delete(lookId);
          }
          await deleteCachedLook(uid, lookId);
        }
      }

      let refreshedCount = 0;
      let reusedCount = 0;

      for (const look of remote) {
        const remoteUpdated = updatedAtMs(look);
        const existing = cacheMap.current.get(look.id);

        // 캐시에 이미 있고, 서버 쪽이 더 새롭지 않고, 썸네일 Blob도 이미 있다면
        // Storage에서 다시 받지 않는다 (요구사항: 변경 없는 룩은 재다운로드 금지).
        if (existing && existing.thumbBlob && existing.updatedAtMs >= remoteUpdated) {
          reusedCount++;
          continue;
        }

        const entry = savedLookToCacheEntry(uid, look);
        entry.updatedAtMs = remoteUpdated;
        entry.thumbBlob = existing?.thumbBlob ?? null;
        entry.thumbType = existing?.thumbType ?? null;

        const srcUrl = look.thumbnailUrl ?? look.imageUrl;
        if (srcUrl) {
          try {
            const res = await fetch(srcUrl);
            if (res.ok) {
              entry.thumbBlob = await res.blob();
              entry.thumbType = entry.thumbBlob.type;
            }
          } catch {
            // 썸네일을 못 받아도 메타데이터는 캐시해 두고, 화면은 원격 URL로 폴백한다.
          }
        }

        cacheMap.current.set(look.id, entry);
        await putCachedLook(entry);
        refreshedCount++;
      }

      publishFromCacheMap();

      const elapsed = Math.round(performance.now() - startedAt);
      log(
        `[local-first] Firestore 동기화 완료 (${elapsed}ms) - 갱신 ${refreshedCount}개 · 캐시 재사용(재다운로드 안 함) ${reusedCount}개`
      );
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[lookie] background sync done in ${elapsed}ms (refreshed=${refreshedCount}, reused=${reusedCount})`
        );
      }
    } catch (err) {
      setOffline(true);
      log(
        `[local-first] Firestore 동기화 실패 - 오프라인일 수 있음, 캐시된 데이터 유지: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setSyncing(false);
    }
  }, [uid, log, publishFromCacheMap]);

  useEffect(() => {
    if (!uid) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- uid가 정해지면 곧바로 백그라운드 동기화를 시작하는 의도적인 데이터 페칭 */
    syncNow();
  }, [uid, syncNow]);

  return { looks, initialSource, syncing, offline, refresh: syncNow };
}
