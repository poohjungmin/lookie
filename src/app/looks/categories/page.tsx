"use client";

import { useState } from "react";
import Link from "next/link";
import { useApp } from "@/lib/AppContext";
import type { DressCategory } from "@/lib/dressLevel";

function CategoryRow({ category, count, busy, onRename, onDelete }: {
  category: DressCategory; count: number; busy: boolean;
  onRename: (name: string) => Promise<void>; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  return (
    <div className="rounded-2xl border border-neutral-200 p-4">
      {editing ? (
        <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
          event.preventDefault();
          try { await onRename(name); setEditing(false); } catch { /* Parent displays the error. */ }
        }}>
          <input aria-label={`${category.name} 새 이름`} required maxLength={20} value={name}
            onChange={(event) => setName(event.target.value)} disabled={busy}
            className="min-w-0 flex-1 rounded-xl border border-neutral-300 px-3 py-2 text-sm" />
          <button disabled={busy} className="rounded-xl bg-neutral-900 px-3 py-2 text-sm text-white disabled:opacity-50">저장</button>
          <button type="button" disabled={busy} onClick={() => setEditing(false)} className="px-2 text-sm text-neutral-500">취소</button>
        </form>
      ) : (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1"><p className="break-words font-medium text-neutral-900">{category.name}</p><p className="mt-1 text-xs text-neutral-400">룩 {count}개</p></div>
          <button disabled={busy} onClick={() => { setName(category.name); setEditing(true); }} className="py-2 text-sm text-neutral-500 disabled:opacity-50">수정</button>
          <button disabled={busy} onClick={onDelete} className="py-2 text-sm text-red-600 disabled:opacity-50">삭제</button>
        </div>
      )}
    </div>
  );
}

export default function CategoriesPage() {
  const { dressCategories, categoriesReady, categoriesError, saveDressCategories, looks } = useApp();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DressCategory | null>(null);

  async function save(categories: DressCategory[], message: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await saveDressCategories(categories);
      setMessage(message);
    } catch (error) {
      setError(error instanceof Error ? error.message : "저장하지 못했어요. 다시 시도해 주세요.");
      throw error;
    } finally { setBusy(false); }
  }

  const disabled = busy || !categoriesReady;
  return (
    <div className="mx-auto max-w-2xl px-5 pb-10 pt-10 sm:px-6">
      <Link href="/looks" className="text-sm text-neutral-500">← 전체 룩</Link>
      <h1 className="mt-6 text-xl font-semibold text-neutral-900">카테고리 관리</h1>
      <p className="mt-2 text-sm text-neutral-500">내 기준에 맞게 꾸밈 카테고리를 바꿔 보세요.</p>
      {categoriesError && <p role="alert" className="mt-4 text-sm text-red-600">{categoriesError}</p>}
      {!categoriesReady && !categoriesError && <p className="mt-4 text-sm text-neutral-400">불러오는 중…</p>}
      <div className="mt-6 space-y-3">
        {dressCategories.map((category) => <CategoryRow key={category.id} category={category}
          count={looks.filter((look) => look.dressLevel === category.id).length} busy={disabled}
          onRename={(name) => save(dressCategories.map((entry) => entry.id === category.id ? { ...entry, name } : entry), "이름을 변경했어요.")}
          onDelete={() => { setError(null); setDeleting(category); }} />)}
      </div>
      {dressCategories.length === 0 && <p className="mt-6 text-sm text-neutral-400">첫 카테고리를 추가해 주세요.</p>}
      <form className="mt-6 flex gap-2" onSubmit={async (event) => {
        event.preventDefault();
        if (disabled) return;
        try {
          await save([...dressCategories, { id: `custom-${crypto.randomUUID()}`, name }], "카테고리를 추가했어요.");
          setName("");
        } catch { /* Error is displayed below. */ }
      }}>
        <input aria-label="새 카테고리 이름" placeholder="새 카테고리 이름" required maxLength={20} value={name}
          disabled={disabled || dressCategories.length >= 30} onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1 rounded-xl border border-neutral-300 px-3 py-3 text-sm" />
        <button disabled={disabled || dressCategories.length >= 30} className="rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white disabled:opacity-50">추가</button>
      </form>
      <p className="mt-2 text-xs text-neutral-400">최대 30개 · 이름은 20자까지</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      {message && <p role="status" className="mt-3 text-sm text-neutral-600">{message}</p>}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-5">
          <div role="dialog" aria-modal="true" aria-labelledby="delete-category-title" className="w-full max-w-sm rounded-3xl bg-white p-6">
            <h2 id="delete-category-title" className="break-words text-lg font-semibold">‘{deleting.name}’ 삭제할까요?</h2>
            <p className="mt-3 text-sm leading-relaxed text-neutral-500">이 카테고리의 룩 {looks.filter((look) => look.dressLevel === deleting.id).length}개는 미분류로 표시됩니다. 사진은 그대로 보관돼요.</p>
            <div className="mt-6 flex gap-3">
              <button disabled={busy} onClick={() => setDeleting(null)} className="flex-1 rounded-xl border border-neutral-200 py-3 text-sm">취소</button>
              <button disabled={disabled} onClick={async () => {
                try { await save(dressCategories.filter((entry) => entry.id !== deleting.id), "카테고리를 삭제했어요."); setDeleting(null); }
                catch { setDeleting(null); }
              }} className="flex-1 rounded-xl bg-red-600 py-3 text-sm text-white disabled:opacity-50">{busy ? "삭제 중…" : "삭제"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
