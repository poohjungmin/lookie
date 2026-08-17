"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Timestamp } from "firebase/firestore";
import {
  fetchUserLooks,
  fetchLookById,
  deleteLookCompletely,
  type SavedLook,
  type DbWeather,
  type DbWeatherStatus,
  type DressLevel,
} from "@/lib/lookStore";
import {
  cacheKeyOf,
  deleteCachedLook,
  getCachedLooks,
  putCachedLook,
  type CachedLook,
} from "@/lib/lookCache";
import { withCacheBust } from "@/lib/cacheBust";

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
    cutoutUrl: look.cutoutUrl,
    cutoutThumbnailUrl: look.cutoutThumbnailUrl,
    cutoutVersion: look.cutoutVersion,
    lastAutoCropRatio: look.lastAutoCropRatio,
    takenAtMs: look.takenAt ? look.takenAt.toMillis() : null,
    latitude: look.latitude,
    longitude: look.longitude,
    weatherStatus: look.weatherStatus,
    weather: look.weather,
    dressLevel: look.dressLevel,
    updatedAtMs: updatedAtMs(look),
    thumbBlob: null,
    thumbType: null,
    cutoutThumbBlob: null,
    cutoutThumbType: null,
    cachedAt: Date.now(),
  };
}

function cacheEntryToDisplayLook(entry: CachedLook, thumbSrc: string): DisplayLook {
  // cutout/cutout-thumb는 같은 Storage 경로에 덮어써서 URL 문자열이 재생성
  // 전후로 동일할 수 있다 - 화면에 실제로 꽂히는 이 두 필드에만 updatedAt
  // 기반 캐시버스터를 붙여, 브라우저가 이전 재생성 시점의 응답을 그대로
  // 재사용하지 못하게 한다 (다른 필드/URL은 건드리지 않는다).
  return {
    id: entry.lookId,
    imageUrl: entry.imageUrl,
    storagePath: "",
    thumbnailUrl: entry.thumbnailUrl,
    thumbnailStoragePath: null,
    cutoutUrl: withCacheBust(entry.cutoutUrl, entry.updatedAtMs),
    cutoutStoragePath: null,
    cutoutThumbnailUrl: withCacheBust(entry.cutoutThumbnailUrl, entry.updatedAtMs),
    cutoutThumbnailStoragePath: null,
    cutoutVersion: entry.cutoutVersion,
    lastAutoCropRatio: entry.lastAutoCropRatio,
    originalFileName: "",
    takenAt: entry.takenAtMs !== null ? Timestamp.fromMillis(entry.takenAtMs) : null,
    latitude: entry.latitude,
    longitude: entry.longitude,
    weather: entry.weather,
    weatherStatus: entry.weatherStatus,
    category: null,
    // 이 필드가 생기기 전 캐시된 항목(entry.dressLevel === undefined)은
    // 자연스럽게 미분류로 취급한다.
    dressLevel: entry.dressLevel ?? null,
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

  // key: `${lookId}:${field}` -> 그 Blob으로 만든 object URL. 재생성 후
  // Blob이 새 인스턴스로 바뀌면(참조가 달라지면) 반드시 이전 URL을 revoke하고
  // 새로 만든다 - 그냥 "이미 URL이 있으니 재사용"하면 Blob 내용이 바뀌어도
  // 화면은 계속 예전 이미지를 보여주는 버그가 생긴다.
  const objectUrls = useRef<Map<string, { url: string; blob: Blob }>>(new Map());
  const cacheMap = useRef<Map<string, CachedLook>>(new Map());

  // 목록/캘린더/홈에서 쓸 썸네일 우선순위 (요구사항 8):
  // 1. IndexedDB에 캐시된 누끼 썸네일 Blob (네트워크 없음)
  // 2. IndexedDB에 캐시된 일반 썸네일 Blob (누끼가 아직 없는 룩도 local-first 유지)
  // 3. 원격 누끼 썸네일 URL
  // 4. 원격 일반 썸네일 URL
  // 5. 원본 imageUrl (최후의 수단 - 목록에서 원본을 우선 쓰지 않는다)
  const getThumbSrc = useCallback((entry: CachedLook): string => {
    const cachedBlob = entry.cutoutThumbBlob ?? entry.thumbBlob;
    if (cachedBlob) {
      const cacheField = entry.cutoutThumbBlob ? "cutout" : "thumb";
      const objectUrlKey = `${entry.lookId}:${cacheField}`;
      const cached = objectUrls.current.get(objectUrlKey);
      if (cached && cached.blob === cachedBlob) {
        return cached.url;
      }
      if (cached) URL.revokeObjectURL(cached.url);
      const url = URL.createObjectURL(cachedBlob);
      objectUrls.current.set(objectUrlKey, { url, blob: cachedBlob });
      return url;
    }
    // 캐시된 Blob이 없어졌으면(재생성 직후 무효화 등) 이전에 만들어둔 object
    // URL도 정리한다 - 안 지우면 참조를 잃어 revoke 못 하는 leak이 된다.
    for (const field of ["cutout", "thumb"]) {
      const key = `${entry.lookId}:${field}`;
      const cached = objectUrls.current.get(key);
      if (cached) {
        URL.revokeObjectURL(cached.url);
        objectUrls.current.delete(key);
      }
    }
    return withCacheBust(entry.cutoutThumbnailUrl, entry.updatedAtMs) ?? entry.thumbnailUrl ?? entry.imageUrl;
  }, []);

  const publishFromCacheMap = useCallback(() => {
    const display = sortByTakenAtDesc(
      Array.from(cacheMap.current.values()).map((e) => cacheEntryToDisplayLook(e, getThumbSrc(e)))
    );
    setLooks(display);
  }, [getThumbSrc]);

  /** 이 lookId로 만들어둔 object URL(누끼/일반 썸네일 둘 다)을 정리한다. */
  const revokeObjectUrlsFor = useCallback((lookId: string) => {
    for (const field of ["cutout", "thumb"]) {
      const key = `${lookId}:${field}`;
      const cached = objectUrls.current.get(key);
      if (cached) {
        URL.revokeObjectURL(cached.url);
        objectUrls.current.delete(key);
      }
    }
  }, []);

  // uid가 바뀔 때(로그인/로그아웃/계정 전환)마다 이전 계정의 상태를 완전히 비운다.
  // -> 다른 계정의 캐시가 화면에 잠깐이라도 비치지 않도록 한다.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 계정이 바뀔 때 이전
       계정의 상태를 즉시 비우는 의도적인 초기화 (다른 계정 캐시 노출 방지) */
    for (const cached of objectUrls.current.values()) URL.revokeObjectURL(cached.url);
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
          revokeObjectUrlsFor(lookId);
          await deleteCachedLook(uid, lookId);
        }
      }

      let refreshedCount = 0;
      let reusedCount = 0;

      for (const look of remote) {
        const remoteUpdated = updatedAtMs(look);
        const existing = cacheMap.current.get(look.id);
        const needsCutoutThumb = !!look.cutoutThumbnailUrl;
        const hasNeededBlob = needsCutoutThumb ? !!existing?.cutoutThumbBlob : !!existing?.thumbBlob;

        // 캐시에 이미 있고, 서버 쪽이 더 새롭지 않고, 화면에 쓸 블롭도 이미
        // 있다면 Storage에서 다시 받지 않는다 (요구사항: 변경 없는 룩은 재다운로드 금지).
        if (existing && hasNeededBlob && existing.updatedAtMs >= remoteUpdated) {
          reusedCount++;
          continue;
        }

        const entry = savedLookToCacheEntry(uid, look);
        entry.updatedAtMs = remoteUpdated;

        // updatedAt이 실제로 전진했다면(문서가 진짜로 바뀌었다면) 이전에
        // 캐싱해둔 Blob은 더 이상 신뢰할 수 없다 - cutout/cutout-thumb은
        // 같은 Storage 경로에 덮어써서 URL 문자열이 그대로일 수 있으므로,
        // "URL이 안 바뀌었으니 안전"이라는 가정이 성립하지 않는다. 여기서
        // 무효화하지 않고 예전 Blob을 그대로 들고 가면, 재생성 직후에도
        // 홈/캘린더/전체 룩이 계속 예전 누끼를 보여주는 버그가 된다.
        // (처음 보는 look이거나 캐시가 최신이면 기존 Blob을 그대로 재사용한다.)
        const isStale = !!existing && existing.updatedAtMs < remoteUpdated;
        entry.thumbBlob = isStale ? null : existing?.thumbBlob ?? null;
        entry.thumbType = isStale ? null : existing?.thumbType ?? null;
        entry.cutoutThumbBlob = isStale ? null : existing?.cutoutThumbBlob ?? null;
        entry.cutoutThumbType = isStale ? null : existing?.cutoutThumbType ?? null;

        if (!entry.thumbBlob && look.thumbnailUrl) {
          try {
            const res = await fetch(look.thumbnailUrl);
            if (res.ok) {
              entry.thumbBlob = await res.blob();
              entry.thumbType = entry.thumbBlob.type;
            }
          } catch {
            // 썸네일을 못 받아도 메타데이터는 캐시해 두고, 화면은 원격 URL로 폴백한다.
          }
        }

        if (!entry.cutoutThumbBlob && look.cutoutThumbnailUrl) {
          try {
            // 같은 URL이라도 브라우저 HTTP 캐시가 예전 응답을 그대로 줄 수
            // 있으므로 버전 쿼리를 붙여 강제로 새로 받는다.
            const bustedUrl = withCacheBust(look.cutoutThumbnailUrl, remoteUpdated) ?? look.cutoutThumbnailUrl;
            const res = await fetch(bustedUrl);
            if (res.ok) {
              entry.cutoutThumbBlob = await res.blob();
              entry.cutoutThumbType = entry.cutoutThumbBlob.type;
            }
          } catch {
            // 누끼 썸네일을 못 받아도 일반 썸네일/원본으로 폴백된다.
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
  }, [uid, log, publishFromCacheMap, revokeObjectUrlsFor]);

  useEffect(() => {
    if (!uid) return;
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- uid가 정해지면 곧바로 백그라운드 동기화를 시작하는 의도적인 데이터 페칭 */
    syncNow();
  }, [uid, syncNow]);

  // 룩 하나를 완전히 삭제한다: Firebase(Storage 파일들 + Firestore 문서) ->
  // IndexedDB 캐시 -> 화면(React state) 순으로 지운다. Firebase 삭제가
  // 실패하면(권한 문제 등) 로컬 상태는 건드리지 않고 그대로 에러를 던진다 -
  // 그래야 실제로는 안 지워졌는데 화면에서만 사라지는 상황을 피할 수 있다.
  const deleteLook = useCallback(
    async (lookId: string) => {
      if (!uid) return;
      await deleteLookCompletely(uid, lookId);

      cacheMap.current.delete(lookId);
      revokeObjectUrlsFor(lookId);
      await deleteCachedLook(uid, lookId);
      publishFromCacheMap();
      log(`[local-first] 룩 삭제 완료 (lookId=${lookId})`);
    },
    [uid, revokeObjectUrlsFor, publishFromCacheMap, log]
  );

  // 룩 하나만 Firestore에서 다시 읽어 IndexedDB 캐시 + 화면 상태를 갱신한다.
  // 누끼를 재생성한 직후처럼 "이 룩 하나만" 확실히 최신 상태여야 하는
  // 경우를 위한 경로 - 전체 목록을 다시 훑는 syncNow와 달리 이 룩의
  // 이미지 캐시를 조건 없이 무조건 무효화하고 새로 받으므로, 서버
  // updatedAt이 어쩌다 같은 값이더라도(같은 밀리초 등) 확실히 갱신된다.
  const refreshSingleLook = useCallback(
    async (lookId: string) => {
      if (!uid) return;
      const remoteLook = await fetchLookById(uid, lookId);
      if (!remoteLook) {
        // 그 사이 삭제된 경우 - 로컬에서도 지운다.
        cacheMap.current.delete(lookId);
        revokeObjectUrlsFor(lookId);
        await deleteCachedLook(uid, lookId);
        publishFromCacheMap();
        return;
      }

      const remoteUpdated = updatedAtMs(remoteLook);
      const entry = savedLookToCacheEntry(uid, remoteLook);
      entry.updatedAtMs = remoteUpdated;
      // 무조건 무효화 - 이 함수를 부르는 시점 자체가 "방금 이 룩의 누끼가
      // 바뀌었다"는 뜻이므로 기존 Blob을 절대 재사용하지 않는다.
      entry.thumbBlob = null;
      entry.thumbType = null;
      entry.cutoutThumbBlob = null;
      entry.cutoutThumbType = null;

      if (remoteLook.thumbnailUrl) {
        try {
          const res = await fetch(withCacheBust(remoteLook.thumbnailUrl, remoteUpdated) ?? remoteLook.thumbnailUrl);
          if (res.ok) {
            entry.thumbBlob = await res.blob();
            entry.thumbType = entry.thumbBlob.type;
          }
        } catch {
          // 못 받아도 메타데이터는 최신으로 반영하고, 화면은 원격 URL로 폴백한다.
        }
      }

      if (remoteLook.cutoutThumbnailUrl) {
        try {
          const bustedUrl =
            withCacheBust(remoteLook.cutoutThumbnailUrl, remoteUpdated) ?? remoteLook.cutoutThumbnailUrl;
          const res = await fetch(bustedUrl);
          if (res.ok) {
            entry.cutoutThumbBlob = await res.blob();
            entry.cutoutThumbType = entry.cutoutThumbBlob.type;
          }
        } catch {
          // 못 받아도 원격 URL(캐시버스팅 적용)로 폴백된다.
        }
      }

      cacheMap.current.set(lookId, entry);
      await putCachedLook(entry);
      publishFromCacheMap();
      log(`[local-first] 룩 단건 갱신 완료 (lookId=${lookId})`);
    },
    [uid, revokeObjectUrlsFor, publishFromCacheMap, log]
  );

  // weather/weatherStatus만 바뀐 룩 하나의 로컬 캐시를 가볍게 갱신한다.
  // refreshSingleLook과 달리 이미지 Blob(썸네일/누끼)은 절대 건드리지
  // 않는다 - 날씨만 바뀌었을 때 캐시된 이미지를 무효화하고 다시 받는 건
  // 순전히 낭비이기 때문. 이미 Firestore 업데이트가 끝난 뒤(개별/일괄 날씨
  // 재조회) 호출하는 용도이므로 네트워크 요청이 전혀 없다 - 로컬 캐시에
  // 없는 lookId면 조용히 아무 것도 하지 않는다(다음 전체 동기화 때 채워진다).
  const patchLookWeather = useCallback(
    (lookId: string, weather: DbWeather | null, weatherStatus: DbWeatherStatus) => {
      const existing = cacheMap.current.get(lookId);
      if (!existing) return;
      const updated: CachedLook = { ...existing, weather, weatherStatus, updatedAtMs: Date.now() };
      cacheMap.current.set(lookId, updated);
      void putCachedLook(updated);
      publishFromCacheMap();
    },
    [publishFromCacheMap]
  );

  // dressLevel만 바뀐 룩 하나의 로컬 캐시를 가볍게 갱신한다. patchLookWeather와
  // 완전히 같은 패턴 - 이미지 Blob은 절대 건드리지 않는다. 꾸밈레벨 분류
  // 화면이 Firestore 응답을 기다리지 않고 선택 즉시 다음 룩으로 넘어갈 수
  // 있는 것은 이 함수가 동기적으로 화면(looks state)부터 갱신하기 때문이다
  // - 실제 Firestore patch(updateLookDressLevel)는 호출부가 비동기로 별도 실행한다.
  const patchLookDressLevel = useCallback(
    (lookId: string, dressLevel: DressLevel | null) => {
      const existing = cacheMap.current.get(lookId);
      if (!existing) return;
      const updated: CachedLook = { ...existing, dressLevel, updatedAtMs: Date.now() };
      cacheMap.current.set(lookId, updated);
      void putCachedLook(updated);
      publishFromCacheMap();
    },
    [publishFromCacheMap]
  );

  return {
    looks,
    initialSource,
    syncing,
    offline,
    refresh: syncNow,
    refreshSingleLook,
    patchLookWeather,
    patchLookDressLevel,
    deleteLook,
  };
}
