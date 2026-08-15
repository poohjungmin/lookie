"use client";

// "Personal crop correction heuristic" 데이터의 Firestore 읽기/쓰기.
// users/{uid}/manualCropCorrections/{id} 서브컬렉션 하나에 사용자별로만
// 쌓인다 - 다른 사용자와 공유하지 않고, Firestore 보안 규칙도
// request.auth.uid == uid만 허용한다 (firestore.rules).
//
// 원본 특징(portrait 여부) + 자동 crop + 사용자 수정 crop의 관계를 그대로
// 보존해서, 나중에 실제 모델 학습을 하고 싶어지면 이 컬렉션을 training
// data로 재사용할 수 있게 스키마를 짰다.

import { addDoc, collection, getDocs, orderBy, query, limit as fsLimit, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebaseClient";
import {
  computeCorrectionDelta,
  type CropRatioBox,
  type ManualCropCorrectionRecord,
} from "@/lib/cropCorrectionMath";

export type ManualCropCorrectionDoc = {
  lookId: string;
  originalImageWidth: number;
  originalImageHeight: number;
  imageIsPortrait: boolean;
  /** 픽셀 좌표 (원본 이미지 기준) - 사람이 보기엔 이쪽이 더 직관적이라 같이 남긴다. */
  autoCrop: { x: number; y: number; width: number; height: number };
  manualCrop: { x: number; y: number; width: number; height: number };
  /** 0~1 비율 - 해상도가 다른 사진에도 재사용할 수 있는 실제 계산용 값. */
  autoCropRatio: CropRatioBox;
  manualCropRatio: CropRatioBox;
  correction: ManualCropCorrectionRecord["correction"];
  createdAt: ReturnType<typeof serverTimestamp>;
};

// 컬렉션이 아무리 커져도 개인화 계산에는 최근 기록 몇백 개면 충분하고,
// 오래된(어쩌면 지금 습관과 다른) 기록의 영향력도 자연스럽게 줄어든다.
const PROFILE_FETCH_LIMIT = 300;
// 세션 내내 매 업로드마다 다시 읽지 않도록 잠깐 캐시한다 - 새 보정을
// 저장하면 캐시에도 바로 반영하므로(아래 saveManualCropCorrection) 이
// TTL은 "다른 기기/세션에서 쌓인 기록을 얼마 만에 반영할지"의 상한일 뿐이다.
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

function correctionsCollection(uid: string) {
  return collection(db, "users", uid, "manualCropCorrections");
}

function toRecord(docData: ManualCropCorrectionDoc): ManualCropCorrectionRecord {
  return {
    imageIsPortrait: docData.imageIsPortrait,
    autoCropRatio: docData.autoCropRatio,
    manualCropRatio: docData.manualCropRatio,
    correction: docData.correction,
  };
}

type ProfileCacheEntry = { records: ManualCropCorrectionRecord[]; fetchedAt: number };
const profileCache = new Map<string, ProfileCacheEntry>();
// 동시에 여러 장을 업로드할 때(Promise.allSettled) 같은 uid로 중복 조회하지
// 않도록 진행 중인 fetch Promise 자체를 공유한다 (weather.ts의 캐시 패턴과 동일).
const inFlightFetches = new Map<string, Promise<ManualCropCorrectionRecord[]>>();

/**
 * 이 사용자의 개인화 보정 기록을 가져온다. 세션 내에서는 캐시를 재사용해서
 * 업로드/누끼 생성 때마다 Firestore를 다시 읽지 않는다 - 개인화를 켜도
 * 사진 한 장당 처리 시간이 거의 늘지 않는 이유가 바로 이 캐시다.
 */
export async function getPersonalCorrectionProfile(uid: string): Promise<ManualCropCorrectionRecord[]> {
  const cached = profileCache.get(uid);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) {
    return cached.records;
  }

  const inFlight = inFlightFetches.get(uid);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const q = query(correctionsCollection(uid), orderBy("createdAt", "desc"), fsLimit(PROFILE_FETCH_LIMIT));
      const snap = await getDocs(q);
      const records = snap.docs.map((d) => toRecord(d.data() as ManualCropCorrectionDoc));
      profileCache.set(uid, { records, fetchedAt: Date.now() });
      return records;
    } catch {
      // 못 읽어도(오프라인 등) 그냥 "개인화 데이터 없음"으로 취급 - 순수
      // 자동 결과로 폴백되므로 업로드 자체를 막지 않는다.
      return [];
    } finally {
      inFlightFetches.delete(uid);
    }
  })();

  inFlightFetches.set(uid, promise);
  return promise;
}

/**
 * 수동 crop 보정 완료 시 기록 한 건을 저장한다. 실패해도(오프라인 등) 상위
 * 호출부(누끼 재생성)를 막지 않도록 그대로 throw하지 않고 호출부가
 * try/catch로 무시할 수 있게 둔다 - 이 기록은 어디까지나 참고용 개인화
 * 데이터지, 누끼 재생성의 필수 조건이 아니다.
 */
export async function saveManualCropCorrection(
  uid: string,
  lookId: string,
  params: {
    originalImageWidth: number;
    originalImageHeight: number;
    autoCropRatio: CropRatioBox;
    manualCropRatio: CropRatioBox;
  }
): Promise<void> {
  const { originalImageWidth, originalImageHeight, autoCropRatio, manualCropRatio } = params;
  const imageIsPortrait = originalImageHeight >= originalImageWidth;
  const correction = computeCorrectionDelta(autoCropRatio, manualCropRatio);

  const toPixelBox = (ratio: CropRatioBox) => ({
    x: Math.round(ratio.x * originalImageWidth),
    y: Math.round(ratio.y * originalImageHeight),
    width: Math.round(ratio.width * originalImageWidth),
    height: Math.round(ratio.height * originalImageHeight),
  });

  const docData: ManualCropCorrectionDoc = {
    lookId,
    originalImageWidth,
    originalImageHeight,
    imageIsPortrait,
    autoCrop: toPixelBox(autoCropRatio),
    manualCrop: toPixelBox(manualCropRatio),
    autoCropRatio,
    manualCropRatio,
    correction,
    createdAt: serverTimestamp(),
  };

  let docRef;
  try {
    docRef = await addDoc(correctionsCollection(uid), docData);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.log(
        [
          "[manual-crop-correction]",
          "saved: false",
          `lookId: ${lookId}`,
          "autoCrop available: true",
          `reason: ${err instanceof Error ? err.message : String(err)}`,
        ].join("\n")
      );
    }
    throw err;
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(
      ["[manual-crop-correction]", "saved: true", `lookId: ${lookId}`, "autoCrop available: true", `correction document id: ${docRef.id}`].join(
        "\n"
      )
    );
  }

  // 이번 세션에서 바로 다음 사진부터 반영되도록 캐시에도 즉시 추가한다
  // (요구사항 8: 새 수동 수정값도 다시 누적해서 참고).
  const cached = profileCache.get(uid);
  const newRecord = toRecord(docData);
  if (cached) {
    cached.records = [newRecord, ...cached.records];
  } else {
    profileCache.set(uid, { records: [newRecord], fetchedAt: Date.now() });
  }
}
