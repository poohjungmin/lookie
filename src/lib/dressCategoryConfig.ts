export type DressCategory = { id: string; name: string };

export const DEFAULT_DRESS_CATEGORIES: DressCategory[] = [
  { id: "casual", name: "안꾸" },
  { id: "effortless", name: "꾸안꾸" },
  { id: "dressed", name: "꾸꾸꾸" },
];

export function validateDressCategories(value: unknown): DressCategory[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error("카테고리를 확인해 주세요.");
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !/^(casual|effortless|dressed|custom-[a-zA-Z0-9-]+)$/.test(entry.id) ||
        typeof entry.name !== "string" || !entry.name.trim() || entry.name.trim().length > 20 ||
        ids.has(entry.id) || names.has(entry.name.trim().toLocaleLowerCase())) {
      throw new Error("이름은 중복 없이 1~20자로 입력해 주세요.");
    }
    ids.add(entry.id);
    names.add(entry.name.trim().toLocaleLowerCase());
    return { id: entry.id, name: entry.name.trim() };
  });
}

