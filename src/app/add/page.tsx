"use client";

import { useRouter } from "next/navigation";
import { useApp } from "@/lib/AppContext";
import { useLookUpload } from "@/lib/useLookUpload";

export default function AddPage() {
  const { user, refreshLooks } = useApp();
  const router = useRouter();
  const { items, handleFiles, total, doneCount, savedCount, duplicateCount, errorCount } =
    useLookUpload(user.uid, refreshLooks);

  const allDone = total > 0 && doneCount === total;

  return (
    <div className="mx-auto max-w-2xl px-5 pb-10 pt-10 sm:px-6">
      <header className="mb-8 text-center">
        <p className="text-xs font-medium tracking-wide text-neutral-400">
          LOOKIE
        </p>
        <h1 className="mt-1 text-xl font-semibold text-neutral-900">
          룩 추가
        </h1>
        <p className="mt-2 text-sm text-neutral-500">
          거울셀카를 선택하면 촬영 날짜·날씨를 자동으로 채워 저장해요
        </p>
      </header>

      {/*
        iOS Safari에서는 input을 버튼 위에 실제 크기로 겹쳐서(opacity:0,
        position:absolute inset:0) 탭이 곧바로 input에 닿게 해야 change
        이벤트가 안정적으로 발생한다 (STEP 1에서 확인된 사항, 그대로 유지).
      */}
      <label className="relative z-10 block w-full cursor-pointer select-none rounded-2xl bg-neutral-900 py-4 text-center text-sm font-medium text-white active:bg-neutral-700">
        사진 선택하기
        <input
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </label>

      {total > 0 && (
        <p className="mt-5 text-center text-sm text-neutral-500">
          {total}장 중 {doneCount}장 처리 완료
          {savedCount > 0 && ` · 저장 ${savedCount}`}
          {duplicateCount > 0 && ` · 중복 ${duplicateCount}`}
          {errorCount > 0 && ` · 실패 ${errorCount}`}
        </p>
      )}

      {items.length > 0 && (
        <div className="mt-6 grid grid-cols-3 gap-1.5">
          {items.map((item) => (
            <div
              key={item.id}
              className="relative aspect-square overflow-hidden rounded-xl bg-neutral-100"
            >
              {item.previewUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.previewUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              )}
              <div className="absolute inset-x-0 bottom-0 bg-black/45 px-2 py-1 text-center text-[10px] text-white">
                {item.saveStage === "idle" && "처리 중…"}
                {item.saveStage === "uploading-photo" && "저장 중…"}
                {item.saveStage === "saving-record" && "저장 중…"}
                {item.saveStage === "saved" && "완료"}
                {item.saveStage === "duplicate" && "이미 등록됨"}
                {item.saveStage === "error" && "실패"}
              </div>
            </div>
          ))}
        </div>
      )}

      {allDone && (
        <button
          type="button"
          onClick={() => router.push("/looks")}
          className="mt-8 w-full rounded-2xl border border-neutral-200 py-3 text-sm font-medium text-neutral-700"
        >
          전체 룩 보러 가기
        </button>
      )}
    </div>
  );
}
