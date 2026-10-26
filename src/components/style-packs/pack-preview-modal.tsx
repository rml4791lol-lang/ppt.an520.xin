"use client";

import Image from "next/image";
import { useEffect } from "react";

/** 风格包/模板共用的整包预览弹窗：大图 + 逐页翻页，ESC/左右方向键可用。 */
export function PackPreviewModal({
  name,
  pages,
  index,
  onIndexChange,
  onClose,
}: {
  name: string;
  pages: string[];
  index: number;
  onIndexChange: (next: number) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onIndexChange((index + pages.length - 1) % pages.length);
      if (event.key === "ArrowRight") onIndexChange((index + 1) % pages.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, pages.length, onIndexChange, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-dark/80 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${name} 预览`}
    >
      <div
        className="relative w-full max-w-4xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative aspect-[16/9] w-full overflow-hidden rounded-2xl bg-page">
          <Image
            src={pages[index]}
            alt={`${name} 第 ${index + 1} 页`}
            fill
            sizes="(max-width: 1024px) 100vw, 896px"
            className="object-contain"
          />
        </div>
        <div className="mt-3 flex items-center justify-between text-sm text-white">
          <button
            type="button"
            onClick={() => onIndexChange((index + pages.length - 1) % pages.length)}
            className="rounded-full border border-white/40 px-4 py-1.5 transition hover:bg-white/10"
          >
            上一页
          </button>
          <span>
            {name} · {index + 1} / {pages.length}
          </span>
          <button
            type="button"
            onClick={() => onIndexChange((index + 1) % pages.length)}
            className="rounded-full border border-white/40 px-4 py-1.5 transition hover:bg-white/10"
          >
            下一页
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-2 right-0 rounded-full border border-white/40 px-3 py-1 text-sm text-white transition hover:bg-white/10"
        >
          关闭
        </button>
      </div>
    </div>
  );
}
