"use client";

import { useMemo, useState } from "react";
import type { StylePack } from "@/data/style-packs";
import { TemplateCard } from "./template-card";

const ALL = "全部";
const COLOR_OPTIONS = ["红", "橙", "黄", "绿", "蓝", "紫"];
const SORT_OPTIONS = [
  { key: "recommended", label: "推荐" },
  { key: "latest", label: "最新" },
  { key: "mostUsed", label: "最多使用" },
] as const;
const DOMAIN_OPTIONS = [
  { key: "wvcsc", label: "世校赛", disabled: false },
  { key: "cicsic", label: "双创赛 · 敬请期待", disabled: true },
  { key: ALL, label: ALL, disabled: false },
] as const;

type SortKey = (typeof SORT_OPTIONS)[number]["key"];

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function Chip({
  active,
  label,
  onToggle,
}: {
  active: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`rounded-full px-3 py-1 text-xs transition ${
        active ? "bg-brand font-medium text-white" : "bg-page text-ink-2 hover:text-brand"
      }`}
    >
      {label}
    </button>
  );
}

/** 模板一版：赛事 → 赛道 → 模板卡三级导航 + 颜色/风格/题材三维筛选 + 排序。 */
export function TemplateGallery({ packs }: { packs: StylePack[] }) {
  const [domain, setDomain] = useState<string>("wvcsc");
  const [track, setTrack] = useState<string>(ALL);
  const [colors, setColors] = useState<string[]>([]);
  const [styles, setStyles] = useState<string[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>("recommended");

  const templates = useMemo(() => packs.filter((pack) => pack.kind === "template"), [packs]);

  const tracks = useMemo(
    () => [
      ...new Set(
        templates
          .filter((pack) => (pack.domain ?? "general") === "wvcsc")
          .map((pack) => pack.track)
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    [templates],
  );
  const styleOptions = useMemo(() => [...new Set(templates.map((pack) => pack.category))], [templates]);
  const themeOptions = useMemo(
    () => [...new Set(templates.flatMap((pack) => pack.themeTags ?? []))],
    [templates],
  );

  const filtered = useMemo(() => {
    let list = templates;
    if (domain !== ALL) list = list.filter((pack) => (pack.domain ?? "general") === domain);
    if (domain === "wvcsc" && track !== ALL) list = list.filter((pack) => pack.track === track);
    if (colors.length > 0) list = list.filter((pack) => (pack.colorTags ?? []).some((tag) => colors.includes(tag)));
    if (styles.length > 0)
      list = list.filter((pack) => styles.includes(pack.category) || pack.tags.some((tag) => styles.includes(tag)));
    if (themes.length > 0) list = list.filter((pack) => (pack.themeTags ?? []).some((tag) => themes.includes(tag)));
    if (sort === "latest") return [...list].reverse();
    // recommended / mostUsed（预留，未接入真实用量前与推荐同序）
    return [...list].sort((a, b) => b.recommendationWeight - a.recommendationWeight);
  }, [templates, domain, track, colors, styles, themes, sort]);

  return (
    <div>
      {/* 一级：赛事 */}
      <div className="flex flex-wrap gap-2">
        {DOMAIN_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            disabled={option.disabled}
            onClick={() => {
              setDomain(option.key);
              setTrack(ALL);
            }}
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              option.disabled
                ? "cursor-not-allowed bg-page text-ink-3/50"
                : domain === option.key
                  ? "bg-brand font-medium text-white"
                  : "bg-card text-ink-2 hover:text-brand"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {/* 二级：赛道（世校赛域内） */}
      {domain === "wvcsc" && tracks.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-3">赛道</span>
          {[ALL, ...tracks].map((value) => (
            <Chip key={value} label={value} active={track === value} onToggle={() => setTrack(value)} />
          ))}
        </div>
      )}

      {/* 三维筛选 + 排序 */}
      <div className="mt-4 space-y-2 rounded-2xl border border-line bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-8 text-xs text-ink-3">颜色</span>
          {COLOR_OPTIONS.map((color) => (
            <Chip key={color} label={color} active={colors.includes(color)} onToggle={() => setColors(toggle(colors, color))} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-8 text-xs text-ink-3">风格</span>
          {styleOptions.map((style) => (
            <Chip key={style} label={style} active={styles.includes(style)} onToggle={() => setStyles(toggle(styles, style))} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="w-8 text-xs text-ink-3">题材</span>
          {themeOptions.map((theme) => (
            <Chip key={theme} label={theme} active={themes.includes(theme)} onToggle={() => setThemes(toggle(themes, theme))} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2">
          <span className="w-8 text-xs text-ink-3">排序</span>
          {SORT_OPTIONS.map((option) => (
            <Chip key={option.key} label={option.label} active={sort === option.key} onToggle={() => setSort(option.key)} />
          ))}
        </div>
      </div>

      {/* 三级：模板卡 */}
      {filtered.length > 0 ? (
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {filtered.map((pack) => (
            <TemplateCard key={pack.id} pack={pack} />
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-dashed border-line-strong bg-card px-6 py-16 text-center text-sm text-ink-3">
          符合条件的模板正在设计中，敬请期待
        </div>
      )}
    </div>
  );
}
