import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
  collection,
  query,
  orderBy,
  getDocs,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject, getBlob } from "firebase/storage";
import { db, storage } from "@/lib/firebaseClient";
import type { CropRatioBox } from "@/lib/cropCorrectionMath";

/** Firestore에 저장하는 날씨 상태 - UI의 세분화된 상태를 3가지로 단순화한다. */
export type DbWeatherStatus = "success" | "missing_metadata" | "failed";

export type DbWeather = {
  weatherCode: number | null;
  weatherLabel: string | null;
  tempMax: number | null;
  tempMin: number | null;
  tempMean: number | null;
  precipitation: number | null;
  windMax: number | null;
};

export type LookRecord = {
  imageUrl: string;
  storagePath: string;
  /**
   * 목록/캘린더/홈용 400px WebP 썸네일. 이 필드가 추가되기 전에 저장된
   * 기존 룩에는 없을 수 있으므로(null) - UI에서는 항상
   * `thumbnailUrl ?? imageUrl` 형태로 폴백해서 써야 한다.
   */
  thumbnailUrl: string | null;
  thumbnailStoragePath: string | null;
  /**
   * 사람 전체를 배경에서 분리한 상세용(긴 변 약 1000px) 투명 이미지.
   * 이 필드가 추가되기 전 룩과, 누끼 생성이 실패한 룩은 null이다 -
   * UI에서는 항상 `cutoutUrl ?? thumbnailUrl ?? imageUrl` 순으로 폴백한다.
   */
  cutoutUrl: string | null;
  cutoutStoragePath: string | null;
  /** 목록/캘린더/홈용 누끼 썸네일(긴 변 약 400~500px, 가능하면 투명 WebP). */
  cutoutThumbnailUrl: string | null;
  cutoutThumbnailStoragePath: string | null;
  /**
   * 이 룩의 cutout/cutoutThumbnail이 생성된 정규화 알고리즘 버전.
   * null/undefined는 "누끼가 없거나 버전 표시 이전의 예전 알고리즘"으로
   * 취급한다 - /dev/cutout-migrate가 CURRENT_CUTOUT_VERSION보다 낮은
   * 룩만 골라 다시 생성한다.
   */
  cutoutVersion: number | null;
  /**
   * 가장 최근 "자동" 누끼 생성이 검출한 사람 bbox (원본 대비 0~1 비율).
   * 사용자가 나중에 이 룩을 수동으로 다시 crop할 때 "자동으로 잡혔던
   * 영역"의 비교 기준으로 쓴다 (personal crop correction heuristic).
   * 수동 crop으로 재생성했을 때는 이 필드를 건드리지 않는다 - 수동 crop
   * 입력은 이미 잘린 부분 이미지라 좌표계가 달라 비교 기준으로 쓸 수 없다.
   * null이면 이전 버전에서 생성됐거나 사람을 못 찾은 룩.
   */
  lastAutoCropRatio: CropRatioBox | null;
  originalFileName: string;

  takenAt: Timestamp | null;
  latitude: number | null;
  longitude: number | null;

  weather: DbWeather | null;
  weatherStatus: DbWeatherStatus;

  category: null;
  dressLevel: null;
  aiAnalysis: null;

  fingerprint: string;
  // Firestore에 쓸 때는 serverTimestamp() sentinel(FieldValue)이 들어가지만,
  // 읽어올 때는 실제 Timestamp 인스턴스로 돌아온다. 이 타입은 "읽은 후" 모양
  // 기준이다 - 쓰기 쪽은 saveLookRecord에서 별도로 FieldValue를 채운다.
  createdAt: Timestamp | null;
  /** 로컬 캐시 동기화 판단용. 문서가 새로 생기거나 갱신될 때마다 서버 시간으로 다시 찍힌다. */
  updatedAt: Timestamp | null;
};

/**
 * 원본 파일명 + 파일 크기 + 촬영일 + lastModified를 조합해 SHA-256으로 해싱한
 * 단순 fingerprint. 이미지 내용을 분석하는 perceptual hash가 아니라,
 * "같은 파일을 다시 선택했는가"만 구분하기 위한 용도.
 * 이 값 자체를 Firestore 문서 ID(lookId)로 사용해 중복 문서 생성을 원천 차단한다.
 */
export async function computeFingerprint(
  file: File,
  takenAt: Date | null
): Promise<string> {
  const raw = [
    file.name,
    file.size,
    takenAt ? takenAt.getTime() : "no-date",
    file.lastModified,
  ].join("|");

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function lookDocRef(uid: string, lookId: string) {
  return doc(db, "users", uid, "looks", lookId);
}

export async function lookAlreadyExists(uid: string, lookId: string): Promise<boolean> {
  const snap = await getDoc(lookDocRef(uid, lookId));
  return snap.exists();
}

/**
 * 저장된 원본 이미지를 Storage에서 다시 받는다 (재누끼 생성용).
 *
 * 일부러 `fetch(look.imageUrl)`로 공개 download URL을 다시 읽지 않는다 -
 * 그건 브라우저의 CORS 검증을 거치는 일반 cross-origin fetch라서, 지금까지
 * 이 앱이 이미지를 보여줄 때 써온 `<img src>`(CORS 검증 대상 아님)나 업로드
 * 때 쓰는 `uploadBytes`(Firebase SDK 자체 네트워크 계층)와는 다른 경로다.
 * 대신 Firebase Storage SDK의 `getBlob()`으로 storagePath를 직접 읽어서,
 * 업로드 때와 동일하게 검증된 SDK 경로만 타도록 한다.
 */
export async function downloadLookOriginal(
  uid: string,
  lookId: string,
  storagePath?: string | null
): Promise<Blob> {
  const path = storagePath || `users/${uid}/looks/${lookId}/original`;
  const storageRef = ref(storage, path);
  return await getBlob(storageRef);
}

export async function uploadLookPhoto(
  uid: string,
  lookId: string,
  file: File
): Promise<{ imageUrl: string; storagePath: string }> {
  const storagePath = `users/${uid}/looks/${lookId}/original`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, file, { contentType: file.type || undefined });
  const imageUrl = await getDownloadURL(storageRef);
  return { imageUrl, storagePath };
}

export async function uploadLookThumbnail(
  uid: string,
  lookId: string,
  blob: Blob
): Promise<{ thumbnailUrl: string; thumbnailStoragePath: string }> {
  const storagePath = `users/${uid}/looks/${lookId}/thumbnail`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, blob, { contentType: blob.type || "image/webp" });
  const thumbnailUrl = await getDownloadURL(storageRef);
  return { thumbnailUrl, thumbnailStoragePath: storagePath };
}

export async function uploadLookCutout(
  uid: string,
  lookId: string,
  blob: Blob
): Promise<{ cutoutUrl: string; cutoutStoragePath: string }> {
  const storagePath = `users/${uid}/looks/${lookId}/cutout`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, blob, { contentType: blob.type || "image/png" });
  const cutoutUrl = await getDownloadURL(storageRef);
  return { cutoutUrl, cutoutStoragePath: storagePath };
}

export async function uploadLookCutoutThumbnail(
  uid: string,
  lookId: string,
  blob: Blob
): Promise<{ cutoutThumbnailUrl: string; cutoutThumbnailStoragePath: string }> {
  const storagePath = `users/${uid}/looks/${lookId}/cutout-thumb`;
  const storageRef = ref(storage, storagePath);
  await uploadBytes(storageRef, blob, { contentType: blob.type || "image/png" });
  const cutoutThumbnailUrl = await getDownloadURL(storageRef);
  return { cutoutThumbnailUrl, cutoutThumbnailStoragePath: storagePath };
}

/**
 * 기존 룩에 누끼 관련 필드만 추가/갱신한다 (마이그레이션용).
 * EXIF·날씨·createdAt·fingerprint 등 다른 필드는 절대 건드리지 않는다.
 * updatedAt만 다시 찍어서 local-first 캐시가 이 변경을 감지해 썸네일을
 * 다시 받도록 한다.
 */
export async function updateLookCutoutFields(
  uid: string,
  lookId: string,
  patch: {
    cutoutUrl: string;
    cutoutStoragePath: string;
    cutoutThumbnailUrl: string;
    cutoutThumbnailStoragePath: string;
    cutoutVersion: number;
    /**
     * 이번 생성이 "자동" 파이프라인일 때만 넘긴다 - 수동 crop 재생성
     * (regenerateLookCutoutFromCrop)은 이 필드를 아예 생략해서 기존 값을
     * 건드리지 않는다 (수동 crop 입력은 좌표계가 달라 비교 기준으로 못 씀).
     */
    lastAutoCropRatio?: CropRatioBox | null;
  }
): Promise<void> {
  await updateDoc(lookDocRef(uid, lookId), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
}

/**
 * 기존 룩의 weather/weatherStatus 필드만 다시 쓴다 (날씨 재조회용).
 * original/thumbnail/cutout/EXIF(takenAt·GPS)·lookId·createdAt 등 다른 필드는
 * 절대 건드리지 않는다. updatedAt만 다시 찍어서 local-first 캐시가 이
 * 변경을 감지하도록 한다(updateLookCutoutFields와 동일한 패턴).
 */
export async function updateLookWeatherFields(
  uid: string,
  lookId: string,
  patch: { weather: DbWeather | null; weatherStatus: DbWeatherStatus }
): Promise<void> {
  await updateDoc(lookDocRef(uid, lookId), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
}

export async function saveLookRecord(
  uid: string,
  lookId: string,
  data: Omit<LookRecord, "createdAt" | "updatedAt">
): Promise<void> {
  await setDoc(lookDocRef(uid, lookId), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Storage 파일 하나를 지운다. 이미 없는 파일(storage/object-not-found)이거나
 * 그 외 어떤 이유로 실패하든 여기서 막히면 안 된다 - 파일 하나의 삭제
 * 실패 때문에 나머지 파일/Firestore 문서 삭제까지 멈추면 안 된다는 요구사항.
 */
async function safeDeleteStorageFile(path: string): Promise<void> {
  try {
    await deleteObject(ref(storage, path));
  } catch {
    // 무시 - object-not-found를 포함해 어떤 에러든 삭제 흐름을 막지 않는다.
  }
}

/**
 * 룩 하나를 완전히 삭제한다: Storage의 original/thumbnail/cutout/cutout-thumb
 * (존재하는 것만) + Firestore 문서. uid는 항상 로그인된 본인의 uid만
 * 호출부에서 넘기도록 되어 있고, Firestore/Storage 보안 규칙도 동일하게
 * request.auth.uid == uid만 허용하므로 다른 사용자의 룩은 애초에 지울 수 없다.
 */
export async function deleteLookCompletely(uid: string, lookId: string): Promise<void> {
  const base = `users/${uid}/looks/${lookId}`;
  const paths = [`${base}/original`, `${base}/thumbnail`, `${base}/cutout`, `${base}/cutout-thumb`];

  await Promise.allSettled(paths.map(safeDeleteStorageFile));
  await deleteDoc(lookDocRef(uid, lookId));
}

export type SavedLook = LookRecord & { id: string };

/**
 * Firestore에서 원시 문서를 읽어 SavedLook으로 정규화한다.
 * thumbnailUrl/updatedAt처럼 나중에 추가된 필드는 예전 문서에 아예 없을 수
 * 있으므로(undefined), 항상 안전한 기본값으로 채운다 - 이게 마이그레이션
 * 친화적 스키마의 핵심이다: 예전 문서를 고쳐 쓰지 않고도 새 코드가 그대로 읽는다.
 */
function normalizeLookDoc(id: string, raw: Partial<LookRecord>): SavedLook {
  return {
    id,
    imageUrl: raw.imageUrl ?? "",
    storagePath: raw.storagePath ?? "",
    thumbnailUrl: raw.thumbnailUrl ?? null,
    thumbnailStoragePath: raw.thumbnailStoragePath ?? null,
    cutoutUrl: raw.cutoutUrl ?? null,
    cutoutStoragePath: raw.cutoutStoragePath ?? null,
    cutoutThumbnailUrl: raw.cutoutThumbnailUrl ?? null,
    cutoutThumbnailStoragePath: raw.cutoutThumbnailStoragePath ?? null,
    cutoutVersion: raw.cutoutVersion ?? null,
    lastAutoCropRatio: raw.lastAutoCropRatio ?? null,
    originalFileName: raw.originalFileName ?? "",
    takenAt: raw.takenAt ?? null,
    latitude: raw.latitude ?? null,
    longitude: raw.longitude ?? null,
    weather: raw.weather ?? null,
    weatherStatus: raw.weatherStatus ?? "missing_metadata",
    category: null,
    dressLevel: null,
    aiAnalysis: null,
    fingerprint: raw.fingerprint ?? id,
    createdAt: (raw.createdAt ?? null) as SavedLook["createdAt"],
    // updatedAt이 없는 예전 문서는 createdAt을 기준 시각으로 대신 쓴다.
    updatedAt: (raw.updatedAt ?? raw.createdAt ?? null) as SavedLook["updatedAt"],
  };
}

export async function fetchUserLooks(uid: string): Promise<SavedLook[]> {
  const q = query(collection(db, "users", uid, "looks"), orderBy("takenAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => normalizeLookDoc(d.id, d.data() as Partial<LookRecord>));
}

/**
 * 룩 하나만 Firestore에서 다시 읽는다. 누끼 재생성처럼 "이 룩 하나만" 최신
 * 상태로 반영하면 되는 경우, 전체 목록을 다시 받는 fetchUserLooks보다
 * 가볍고 즉시 반영된다. 문서가 없으면(삭제 등) null.
 */
export async function fetchLookById(uid: string, lookId: string): Promise<SavedLook | null> {
  const snap = await getDoc(lookDocRef(uid, lookId));
  if (!snap.exists()) return null;
  return normalizeLookDoc(snap.id, snap.data() as Partial<LookRecord>);
}
