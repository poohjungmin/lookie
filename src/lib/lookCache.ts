"use client";

import type { DbWeather, DbWeatherStatus } from "@/lib/lookStore";

const DB_NAME = "lookie-cache";
const DB_VERSION = 1;
const STORE = "looks";

/**
 * IndexedDB에 저장하는 로컬 캐시 항목. Firebase Storage/Firestore가
 * source of truth이고, 이건 어디까지나 "다시 못 받아도 앱이 그냥 동작하는"
 * 캐시다. base64 문자열이 아니라 실제 Blob으로 썸네일을 저장한다
 * (localStorage에 base64 이미지를 넣지 않는다는 요구사항).
 */
export type CachedLook = {
  /** `${uid}::${lookId}` - 오브젝트 스토어의 primary key */
  cacheKey: string;
  uid: string;
  lookId: string;
  imageUrl: string;
  thumbnailUrl: string | null;
  /** 상세 화면용 누끼 (긴 변 약 1000px). */
  cutoutUrl: string | null;
  /** 목록/캘린더/홈에서 원본보다 우선 쓰는 누끼 썸네일 (요구사항 8의 우선순위 1~2번). */
  cutoutThumbnailUrl: string | null;
  takenAtMs: number | null;
  latitude: number | null;
  longitude: number | null;
  weatherStatus: DbWeatherStatus;
  weather: DbWeather | null;
  /** Firestore updatedAt(없으면 createdAt)을 ms로 변환한 값. 동기화 diff 기준. */
  updatedAtMs: number;
  thumbBlob: Blob | null;
  thumbType: string | null;
  cutoutThumbBlob: Blob | null;
  cutoutThumbType: string | null;
  cachedAt: number;
};

export function cacheKeyOf(uid: string, lookId: string): string {
  return `${uid}::${lookId}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB를 사용할 수 없는 환경"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "cacheKey" });
        store.createIndex("by_uid", "uid", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 모든 함수는 IndexedDB 접근 자체가 실패해도(사파리 프라이빗 브라우징,
// 저장공간 정책 등) throw하지 않는다 - 캐시는 있으면 좋은 것이지,
// 없다고 앱이 망가지면 안 된다 (Firebase가 여전히 source of truth).

export async function getCachedLooks(uid: string): Promise<CachedLook[]> {
  try {
    const db = await openDb();
    return await new Promise<CachedLook[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const index = tx.objectStore(STORE).index("by_uid");
      const req = index.getAll(IDBKeyRange.only(uid));
      req.onsuccess = () => resolve(req.result as CachedLook[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function putCachedLook(entry: CachedLook): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 무시 - 다음 동기화 때 다시 시도된다.
  }
}

export async function deleteCachedLook(uid: string, lookId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(cacheKeyOf(uid, lookId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 무시
  }
}

/** 로그아웃/계정 전환 시 이 uid의 캐시를 정리하고 싶을 때 사용 (선택적). */
export async function clearCacheForUid(uid: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const index = tx.objectStore(STORE).index("by_uid");
      const req = index.openKeyCursor(IDBKeyRange.only(uid));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          tx.objectStore(STORE).delete(cursor.primaryKey);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // 무시
  }
}
