"use client";

import Image from "next/image";
import { useState } from "react";
import type { StylePack } from "@/data/style-packs";
import { PackPreviewModal } from "@/components/style-packs/pack-preview-modal";

const BADGE_TONE: Record<string, string> = {
  推荐: "bg-brand text-white",
  热门: "bg-brand text-white",
  上新: "bg-emerald-500 text-white",
  超受欢迎: "bg-brand text-white",
};

export function StylePackCard({
  pack,
  onUse,
}: {
  pack: StylePack;
  onUse?: (pack: StylePack) => void;
}) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const pages = pack.previewImageUrls.length > 0 ? pack.previewImageUrls : [pack.previewUrl];

  return (
    <div className="flex flex-col rounded-2xl border border-line bg-card p-3 shadow-card transition hover:shadow-pop">
      <div className="relative overflow-hidden rounded-xl">
        <button
          type="button"
          onClick={() => setPreviewIndex(0)}
          className="relative block aspect-[16/9] w-full bg-page"
          aria-label={`预览 ${pack.name}`}
        >
          <Image
            src={pack.previewUrl}
            alt={`${pack.name} 预览图`}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1280px) 33vw, 280px"
            className="object-cover"
          />
        </button>
        {pack.badgeText && (
          <span
            className={`absolute left-2 top-2 rounded-full px-2.5 py-1 text-[11px] font-medium leading-none ${
              BADGE_TONE[pack.badgeText] ?? "bg-dark text-white"
            }`}
          >
            {pack.badgeText}
          </span>
        )}
      </div>

      <h3 className="mt-3 px-1 text-[15px] font-semibold text-ink">
        {pack.name}
      </h3>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
        <span className="rounded-md bg-page px-2 py-0.5 text-xs text-ink-2">
          {pack.category}
        </span>
        {pack.tags.slice(0, 2).map((tag) => (
          <span key={tag} className="rounded-md bg-page px-2 py-0.5 text-xs text-ink-3">
            # {tag}
          </span>
        ))}
      </div>
      {pack.description && (
        <p className="mt-2 line-clamp-2 px-1 text-[13px] leading-5 text-ink-3">
          {pack.description}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setPreviewIndex(0)}
          className="flex-1 rounded-full border border-line-strong py-2 text-sm font-medium text-ink transition hover:border-brand hover:text-brand"
        >
          预览
        </button>
        {onUse ? (
          <button
            type="button"
            onClick={() => onUse(pack)}
            className="flex-1 rounded-full border border-line-strong py-2 text-sm font-medium text-ink transition hover:border-brand hover:text-brand"
          >
            使用此风格
          </button>
        ) : (
          <a
            href={`/?style=${encodeURIComponent(pack.slug)}`}
            className="flex-1 rounded-full border border-line-strong py-2 text-center text-sm font-medium text-ink transition hover:border-brand hover:text-brand"
          >
            使用此风格
          </a>
        )}
      </div>

      {previewIndex !== null && (
        <PackPreviewModal
          name={pack.name}
          pages={pages}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}
