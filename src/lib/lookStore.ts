import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  Timestamp,
  collection,
  query,
  orderBy,
  getDocs,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebaseClient";

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
  createdAt: ReturnType<typeof serverTimestamp>;
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

export async function saveLookRecord(
  uid: string,
  lookId: string,
  data: Omit<LookRecord, "createdAt">
): Promise<void> {
  await setDoc(lookDocRef(uid, lookId), {
    ...data,
    createdAt: serverTimestamp(),
  });
}

export type SavedLook = LookRecord & { id: string };

export async function fetchUserLooks(uid: string): Promise<SavedLook[]> {
  const q = query(collection(db, "users", uid, "looks"), orderBy("takenAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as LookRecord) }));
}
