"use client";

import { useMemo, useState } from "react";
import { StylePackBrowser } from "@/components/style-pack-browser";
import { useFeatureFlag } from "@/components/use-feature-flag";
import { useGatedStylePacks } from "@/components/use-gated-style-packs";
import type { StylePack } from "@/data/style-packs";
import { OwnTemplatePanel } from "@/modules/ppt-replicate/client/own-template-panel";
import { TemplateGallery } from "./template-gallery";

type LibraryTab = "template" | "style" | "own";

/** 模板库：官方模板灌内容 / 风格包借感觉 / 自己的 PPT 保画面美化。 */
export function TemplateLibrary({
  packs,
  categories,
}: {
  packs: StylePack[];
  categories: string[];
}) {
  const [tab, setTab] = useState<LibraryTab>("template");
  const gatedPacks = useGatedStylePacks();
  const showOwn = useFeatureFlag("ppt_replicate");
  const allPacks = useMemo(
    () => (gatedPacks.length > 0 ? [...packs, ...gatedPacks] : packs),
    [packs, gatedPacks],
  );

  const tabs: { key: LibraryTab; label: string }[] = [
    { key: "template", label: "模板一版" },
    { key: "style", label: "风格一版" },
    ...(showOwn ? [{ key: "own" as const, label: "自己的 PPT" }] : []),
  ];

  const hint =
    tab === "template"
      ? "找成品：内容灌进现成版式"
      : tab === "style"
        ? "找感觉：只借鉴视觉风格"
        : "保画面：用你的演示文稿当模板";

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              tab === item.key ? "bg-brand font-medium text-white" : "bg-card text-ink-2 hover:text-brand"
            }`}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-1 hidden self-center text-xs text-ink-3 sm:inline">{hint}</span>
      </div>

      <div className="mt-6">
        {tab === "template" ? (
          <TemplateGallery packs={allPacks} />
        ) : tab === "style" ? (
          <StylePackBrowser packs={allPacks} categories={categories} />
        ) : (
          <OwnTemplatePanel />
        )}
      </div>
    </div>
  );
}
