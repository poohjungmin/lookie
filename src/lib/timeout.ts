"use client";

/**
 * 일부 네트워크 호출(특히 Firebase Storage getBlob())이 에러 없이 그냥
 * 멈춰버리는 경우가 실측 확인되었다 - reject도 resolve도 안 하는 상태.
 * 무한 대기를 막고, 최소한 "몇 초 내에 응답 없음"이라는 진단 정보라도
 * 남기기 위한 공용 타임아웃 래퍼.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} - ${Math.round(ms / 1000)}초 내에 응답 없음 (timeout)`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
