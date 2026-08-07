import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// Next.js는 클라이언트 컴포넌트도 최초 1회 서버(Node) 환경에서 렌더링한다.
// Firebase SDK는 브라우저 전용 API(window, indexedDB 등)를 기대하므로,
// 브라우저에서만 실제로 초기화하고 서버에서는 undefined로 둔다.
// (auth/db/storage 사용처는 전부 useEffect/이벤트 핸들러 등 클라이언트 실행 경로뿐이라 안전함)
function getFirebaseApp(): FirebaseApp | undefined {
  if (typeof window === "undefined") return undefined;
  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

const app = getFirebaseApp();

export const auth = app ? getAuth(app) : (undefined as unknown as Auth);
export const db = app ? getFirestore(app) : (undefined as unknown as Firestore);
export const storage = app ? getStorage(app) : (undefined as unknown as FirebaseStorage);
export const googleProvider = new GoogleAuthProvider();
