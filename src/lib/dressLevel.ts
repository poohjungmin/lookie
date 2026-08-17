import type { DressLevel } from "@/lib/lookStore";

export type { DressLevel };

// 표시 순서 - 안꾸(0) -> 꾸안꾸(1) -> 꾸꾸꾸(2). UI에는 이 배열 순서 그대로
// 3개 버튼을 렌더링한다.
export const DRESS_LEVELS: DressLevel[] = ["casual", "effortless", "dressed"];

const LABELS: Record<DressLevel, string> = {
  casual: "안꾸",
  effortless: "꾸안꾸",
  dressed: "꾸꾸꾸",
};

/** 내부 코드(casual/effortless/dressed)는 UI에 절대 노출하지 않고, 항상 이 한글 라벨만 보여준다. */
export function dressLevelLabel(level: DressLevel): string {
  return LABELS[level];
}

// --- 기온 검색 / 홈 추천에서 쓰는 꾸밈레벨 "필터" ---------------------------
// 분류(DressLevel)와 달리 "전체"라는 네 번째 선택지가 있다 - 사전 필터
// 용도로만 쓰이고, 어떤 similarity 점수 계산에도 관여하지 않는다.

export type DressLevelFilter = DressLevel | "all";

// 표시 순서 - 전체 -> 안꾸 -> 꾸안꾸 -> 꾸꾸꾸.
export const DRESS_LEVEL_FILTERS: DressLevelFilter[] = ["all", ...DRESS_LEVELS];

export function dressLevelFilterLabel(filter: DressLevelFilter): string {
  return filter === "all" ? "전체" : dressLevelLabel(filter);
}

/** URL 쿼리 등 외부 문자열 값을 안전한 DressLevelFilter로 정규화한다 (모르는 값은 "all"). */
export function parseDressLevelFilter(value: string | null | undefined): DressLevelFilter {
  return (DRESS_LEVEL_FILTERS as string[]).includes(value ?? "") ? (value as DressLevelFilter) : "all";
}

/**
 * 꾸밈레벨 사전 필터 - similarity 계산 전에 후보를 걸러내기만 한다(점수에
 * 관여하지 않음). "전체"면 그대로 통과하고, 특정 레벨을 고르면 미분류
 * (dressLevel == null) 룩은 결과에서 빠진다 - 아직 분류 안 한 룩 때문에
 * "전체"일 때의 결과가 줄어들면 안 되지만, 특정 레벨만 볼 때는 미분류를
 * 섞어 보여줄 이유가 없기 때문.
 */
export function filterLooksByDressLevel<T extends { dressLevel: DressLevel | null }>(
  looks: T[],
  filter: DressLevelFilter
): T[] {
  if (filter === "all") return looks;
  return looks.filter((look) => look.dressLevel === filter);
}
