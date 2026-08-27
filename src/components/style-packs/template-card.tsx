"use client";

import Image from "next/image";
import { useState } from "react";
import type { StylePack } from "@/data/style-packs";
import { PackPreviewModal } from "./pack-preview-modal";

const DOMAIN_LABEL: Record<string, string> = {
  wvcsc: "世校赛",
  cicsic: "双创赛",
};

/** 模板一版卡片：封面 / 名称 / 赛道 / 热度（静态占位）+ 预览（大图翻页）/ 使用模板。 */
export function TemplateCard({ pack }: { pack: StylePack }) {
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
            alt={`${pack.name} 封面`}
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1280px) 33vw, 280px"
            className="object-cover"
          />
        </button>
        {pack.badgeText && (
          <span className="absolute left-2 top-2 rounded-full bg-dark px-2.5 py-1 text-[11px] font-medium leading-none text-white">
            {pack.badgeText}
          </span>
        )}
      </div>

      <h3 className="mt-3 px-1 text-[15px] font-semibold text-ink">{pack.name}</h3>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
        {pack.domain && pack.domain !== "general" && (
          <span className="rounded-md bg-brand px-2 py-0.5 text-xs text-white">
            {DOMAIN_LABEL[pack.domain] ?? pack.domain}
            {pack.track ? ` · ${pack.track}` : ""}
          </span>
        )}
        <span className="rounded-md bg-page px-2 py-0.5 text-xs text-ink-2">{pack.category}</span>
        {(pack.themeTags ?? []).slice(0, 2).map((tag) => (
          <span key={tag} className="rounded-md bg-page px-2 py-0.5 text-xs text-ink-3">
            # {tag}
          </span>
        ))}
      </div>
      <p className="mt-2 px-1 text-xs text-ink-3">热度 {pack.recommendationWeight}</p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => setPreviewIndex(0)}
          className="flex-1 rounded-full border border-line-strong py-2 text-sm font-medium text-ink transition hover:border-brand hover:text-brand"
        >
          预览
        </button>
        <a
          href={`/?style=${encodeURIComponent(pack.slug)}`}
          className="flex-1 rounded-full bg-brand py-2 text-center text-sm font-medium text-white transition hover:opacity-90"
        >
          使用模板
        </a>
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
