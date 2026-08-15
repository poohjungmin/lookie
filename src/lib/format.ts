export function formatDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

/**
 * `takenAt`처럼 Firestore Timestamp로 저장되는 촬영일을 안전하게 Date로
 * 바꾼다. 정상적인 Timestamp 인스턴스(.toDate()를 가진 값)와, 혹시 있을
 * 레거시/비정상 데이터(순수 JS Date, 잘못된 값)를 모두 다루면서 항상 같은
 * 결과를 내도록 화면 여러 곳(날짜 표시, 날씨 재조회 가능 여부 판단 등)이
 * 이 함수 하나만 쓰게 한다 - 필드 존재 여부만 얕게 체크하는 곳과 실제
 * `.toDate()`를 부르는 곳이 서로 다른 결론을 내리는 불일치를 막기 위함.
 */
export function toUsableDate(value: unknown): Date | null {
  if (value && typeof (value as { toDate?: unknown }).toDate === "function") {
    const date = (value as { toDate: () => Date }).toDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  return null;
}
