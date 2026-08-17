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
