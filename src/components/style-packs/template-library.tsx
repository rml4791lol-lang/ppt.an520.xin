"use client";

import { useMemo, useState } from "react";
import { StylePackBrowser } from "@/components/style-pack-browser";
import { PluginSlotPanel, usePluginEntries } from "@/components/plugin-ui";
import { useGatedStylePacks } from "@/components/use-gated-style-packs";
import type { StylePack } from "@/data/style-packs";
import { TemplateGallery } from "./template-gallery";

const PLATFORM_TABS = [
  { key: "template", label: "模板一版", hint: "找成品：内容灌进现成版式" },
  { key: "style", label: "风格一版", hint: "找感觉：只借鉴视觉风格" },
];

/** 模板库：官方模板灌内容 / 风格包借感觉 / 插件页签各自挂载。 */
export function TemplateLibrary({
  packs,
  categories,
}: {
  packs: StylePack[];
  categories: string[];
}) {
  const [tab, setTab] = useState("template");
  const gatedPacks = useGatedStylePacks();
  const pluginTabs = usePluginEntries("template-library");
  const allPacks = useMemo(
    () => (gatedPacks.length > 0 ? [...packs, ...gatedPacks] : packs),
    [packs, gatedPacks],
  );

  const tabs = useMemo(
    () => [
      ...PLATFORM_TABS,
      ...pluginTabs.map((entry) => ({
        key: entry.id,
        label: entry.label,
        hint: entry.hint ?? "",
      })),
    ],
    [pluginTabs],
  );

  // 插件入口不存在时，渲染回落到第一个平台页签（开关只影响可见入口，不改壳）
  const activeTab = tabs.some((item) => item.key === tab) ? tab : "template";
  const hint = tabs.find((item) => item.key === activeTab)?.hint ?? "";
  const pluginEntry = pluginTabs.find((entry) => entry.id === activeTab);

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              activeTab === item.key ? "bg-brand font-medium text-white" : "bg-card text-ink-2 hover:text-brand"
            }`}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-1 hidden self-center text-xs text-ink-3 sm:inline">{hint}</span>
      </div>

      <div className="mt-6">
        {activeTab === "template" ? (
          <TemplateGallery packs={allPacks} />
        ) : activeTab === "style" ? (
          <StylePackBrowser packs={allPacks} categories={categories} />
        ) : pluginEntry ? (
          <PluginSlotPanel entry={pluginEntry} />
        ) : null}
      </div>
    </div>
  );
}
