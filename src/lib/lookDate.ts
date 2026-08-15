import { toUsableDate } from "@/lib/format";

/**
 * 이 룩의 날씨 조회(그리고 상세 화면 표시)에 쓸 "촬영일"을 하나의 기준으로
 * 결정한다. 지금 스키마에는 날짜 필드가 takenAt 하나뿐이지만(EXIF 자동
 * 추출이든, 다른 경로로 채워 넣은 값이든 결국 이 필드로 들어온다), 판정
 * 로직을 이 함수 하나로 묶어둬서 나중에 "사용자가 직접 날짜를 설정하는
 * 필드" 같은 게 추가되더라도 업로드/개별 재조회/일괄 재조회/상세 화면
 * 표시가 전부 자동으로 같은 규칙을 따르게 한다. 여러 곳이 각자 다른
 * 기준으로 "날짜가 있다/없다"를 판단하면서 상세 화면엔 날짜가 뜨는데
 * 날씨 쪽은 날짜가 없다고 하는 식의 불일치가 다시 생기는 것을 막는 게
 * 이 함수를 따로 둔 이유다.
 */
export function resolveLookDate(look: { takenAt: unknown }): Date | null {
  return toUsableDate(look.takenAt);
}
