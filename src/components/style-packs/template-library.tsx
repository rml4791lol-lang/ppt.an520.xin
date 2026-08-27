"use client";

import { useMemo, useState } from "react";
import { StylePackBrowser } from "@/components/style-pack-browser";
import { useGatedStylePacks } from "@/components/use-gated-style-packs";
import type { StylePack } from "@/data/style-packs";
import { TemplateGallery } from "./template-gallery";

/** 模板库双路线入口：模板一版（找成品，真模板灌内容）/ 风格一版（找感觉，借风格）。 */
export function TemplateLibrary({
  packs,
  categories,
}: {
  packs: StylePack[];
  categories: string[];
}) {
  const [tab, setTab] = useState<"template" | "style">("template");
  const gatedPacks = useGatedStylePacks();
  const allPacks = useMemo(
    () => (gatedPacks.length > 0 ? [...packs, ...gatedPacks] : packs),
    [packs, gatedPacks],
  );

  return (
    <div>
      <div className="flex gap-2">
        {(
          [
            { key: "template", label: "模板一版", hint: "找成品：内容灌进现成版式" },
            { key: "style", label: "风格一版", hint: "找感觉：只借鉴视觉风格" },
          ] as const
        ).map((item) => (
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
        <span className="ml-1 hidden self-center text-xs text-ink-3 sm:inline">
          {tab === "template" ? "找成品：内容灌进现成版式" : "找感觉：只借鉴视觉风格"}
        </span>
      </div>

      <div className="mt-6">
        {tab === "template" ? (
          <TemplateGallery packs={allPacks} />
        ) : (
          <StylePackBrowser packs={allPacks} categories={categories} />
        )}
      </div>
    </div>
  );
}
