"use client";

// 单页生成器右侧面板与画布下方组件（SINGLEPAGE-UI-SPEC §6/§7）。
// - StylePanel：风格包选择 + 生成版本数 + 生成主按钮
// - RefineBar / VersionBar：result 画布下方
// - ExportPanel：导出选项（图片版 PPTX；可编辑版置灰「即将上线」）
import Image from "next/image";
import { useState } from "react";
import { CheckIcon, SparklesIcon, WandIcon } from "@/components/icons";
import { STYLE_PACKS } from "@/data/style-packs";
import { DownloadIcon, Spinner } from "@/components/deck/ui";
import type { SpPage } from "@/lib/client/single-page-store";

export type VersionCount = 1 | 2 | 4;

/* ---------------- 风格包面板（style 步右栏） ---------------- */

export function StylePanel({
  selectedId,
  versionCount,
  generating,
  onSelect,
  onVersionCount,
  onGenerate,
}: {
  selectedId: string | null;
  versionCount: VersionCount;
  generating: boolean;
  onSelect: (id: string) => void;
  onVersionCount: (n: VersionCount) => void;
  onGenerate: () => void;
}) {
  const selected = STYLE_PACKS.find((p) => p.id === selectedId) ?? null;
  const recommended = [...STYLE_PACKS]
    .sort((a, b) => b.recommendationWeight - a.recommendationWeight)
    .slice(0, 6);

  return (
    <div className="flex h-full flex-col">
      <h2 className="px-1 text-sm font-semibold text-ink">风格包</h2>

      <div className="mt-3 px-1">
        <p className="text-xs text-ink-4">当前已选风格</p>
        {selected ? (
          <div className="mt-2 flex items-center gap-2.5 rounded-xl border border-brand-line bg-brand-softer p-2.5">
            <span className="relative h-10 w-16 shrink-0 overflow-hidden rounded-lg bg-page">
              <Image src={selected.previewUrl} alt={selected.name} fill sizes="64px" className="object-cover" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-ink">{selected.name}</span>
              <span className="text-[11px] text-ink-3">{selected.category}</span>
            </span>
            <CheckIcon width={14} height={14} className="ml-auto shrink-0 text-brand" />
          </div>
        ) : (
          <p className="mt-2 rounded-xl bg-page px-3 py-2.5 text-xs leading-5 text-ink-3">
            尚未选择风格，点下方推荐卡片选择。
          </p>
        )}
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-1">
        <p className="text-xs text-ink-4">
          请挑选风格包
          <span className="ml-1 text-ink-4">· 风格包会影响生成的PPT页面的风格倾向</span>
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2.5">
          {recommended.map((pack) => {
            const active = pack.id === selectedId;
            return (
              <button
                key={pack.id}
                type="button"
                onClick={() => onSelect(pack.id)}
                className={`overflow-hidden rounded-xl border text-left transition ${
                  active ? "border-brand ring-2 ring-brand/25" : "border-line hover:border-brand-line"
                }`}
              >
                <span className="relative block aspect-[16/9] bg-page">
                  <Image
                    src={pack.previewUrl}
                    alt={`${pack.name} 预览图`}
                    fill
                    sizes="160px"
                    className="object-cover"
                  />
                </span>
                <span className="block truncate px-2 py-1.5 text-xs font-medium text-ink">
                  {pack.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 生成控制区 */}
      <div className="border-t border-line px-1 pt-3">
        <p className="text-xs font-medium text-ink-3">生成版本数</p>
        <div className="mt-1.5 flex gap-1 rounded-xl bg-page p-1">
          {([1, 2, 4] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onVersionCount(n)}
              className={`flex-1 rounded-lg py-1.5 text-xs transition ${
                versionCount === n ? "bg-card font-medium text-ink shadow-card" : "text-ink-3 hover:text-ink"
              }`}
            >
              {n} 个
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!selectedId || generating}
          title={!selectedId ? "选择风格包后开始生成" : undefined}
          onClick={onGenerate}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-brand py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
        >
          {generating ? (
            <>
              <Spinner /> 生成中…
            </>
          ) : (
            <>
              <SparklesIcon width={14} height={14} />
              {selectedId ? `已选择风格包，开始生成 · ${versionCount * 10}🌟` : "选择风格包后开始生成"}
            </>
          )}
        </button>
        <p className="mt-2 text-center text-[11px] leading-4 text-ink-4">
          正在调用生图模型，请稍候（可能需要十几秒到数十秒）
          <br />
          每个版本 10🌟，失败自动退还
        </p>
      </div>
    </div>
  );
}

/* ---------------- result 画布下方：优化条 + 版本条 ---------------- */

export function RefineBar({
  page,
  refining,
  onSubmit,
  onRevert,
}: {
  page: SpPage;
  refining: boolean;
  onSubmit: (instruction: string) => void;
  onRevert: () => void;
}) {
  const [value, setValue] = useState("");
  const hasOptimized = page.versions.some((v) => v.optimized);
  const showingOptimized = page.versions.find((v) => v.versionId === page.activeVersionId)?.optimized;

  if (hasOptimized && showingOptimized) {
    return (
      <div className="flex items-center justify-between rounded-2xl border border-line bg-card px-4 py-3">
        <p className="text-xs text-ink-3">已优化当前版本 — 点击「退回原版本」可重新输入要求</p>
        <button
          type="button"
          onClick={onRevert}
          className="shrink-0 rounded-full border border-line-strong px-4 py-1.5 text-xs text-ink-2 transition hover:border-brand-line"
        >
          退回原版本
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-2xl border border-line bg-card p-2 pl-4">
      <WandIcon width={14} height={14} className="shrink-0 text-brand" />
      <input
        value={value}
        disabled={refining}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) {
            onSubmit(value.trim());
            setValue("");
          }
        }}
        placeholder="描述如何重新设计此页面，例如：把标题放大、突出利润数据、背景更简洁…"
        className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-4"
      />
      <button
        type="button"
        disabled={!value.trim() || refining}
        onClick={() => {
          onSubmit(value.trim());
          setValue("");
        }}
        className="shrink-0 rounded-full bg-brand px-4 py-2 text-xs font-medium text-white transition hover:bg-brand-strong disabled:opacity-40"
      >
        {refining ? "重新设计中…" : "重新设计此页面 · 10🌟"}
      </button>
    </div>
  );
}

export function VersionBar({
  page,
  switchingId,
  onSelect,
}: {
  page: SpPage;
  /** 正在切换中的版本 id（select-version 请求在飞）；非空时整条禁用 */
  switchingId?: string | null;
  onSelect: (versionId: string) => void;
}) {
  if (page.versions.length === 0) return null;
  const busy = !!switchingId || page.status === "generating";
  return (
    <div className="flex items-center gap-2 overflow-x-auto rounded-2xl border border-line bg-card p-2">
      {page.versions.map((v, i) => {
        const active = v.versionId === page.activeVersionId;
        const switching = v.versionId === switchingId;
        return (
          <button
            key={v.versionId}
            type="button"
            disabled={busy && !active}
            title={page.status === "generating" ? "页面正在生成中，请稍候再切换版本" : undefined}
            onClick={() => onSelect(v.versionId)}
            className={`flex shrink-0 flex-col items-center gap-1 rounded-xl border p-1.5 transition ${
              active ? "border-brand ring-1 ring-brand/30" : "border-line hover:border-brand-line"
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={v.imageUrl} alt={`版本 ${i + 1}`} className="h-12 w-20 rounded-lg object-cover" />
            <span className="text-[10px] text-ink-3">
              {switching ? "切换中…" : `版本 ${String(i + 1).padStart(2, "0")}`}
              {!switching && v.optimized && " · 已优化"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- 导出面板（result 步右栏） ---------------- */

export function ExportPanel({
  pages,
  exporting,
  onExportImage,
  onRestyle,
}: {
  pages: SpPage[];
  exporting: boolean;
  onExportImage: () => void;
  onRestyle: () => void;
}) {
  const doneCount = pages.filter((p) => p.status === "done").length;
  return (
    <div className="flex h-full flex-col">
      <h2 className="px-1 text-sm font-semibold text-ink">导出选项</h2>
      <p className="mt-1 px-1 text-xs text-ink-4">整套 {doneCount}/{pages.length} 页已生成</p>

      <div className="mt-4 space-y-2.5 px-1">
        <button
          type="button"
          disabled={exporting || doneCount === 0}
          title={doneCount === 0 ? "还没有已生成的页面，无法导出" : "导出图片版 PPTX（免费）"}
          onClick={onExportImage}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-brand py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
        >
          <DownloadIcon />
          {exporting ? "导出中…" : "导出图片版 PPTX"}
        </button>
        <button
          type="button"
          disabled
          title="可编辑导出即将上线"
          className="w-full cursor-not-allowed rounded-full border border-line-strong py-2.5 text-sm text-ink-4"
        >
          转为可编辑 PPTX · 即将上线
        </button>
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <button
          type="button"
          onClick={onRestyle}
          className="w-full rounded-full py-2 text-sm text-ink-3 transition hover:bg-page hover:text-brand"
        >
          {doneCount > 0 ? "换个风格，重新设计" : "重新生成"}
        </button>
      </div>

      <p className="mt-auto px-1 pt-4 text-[11px] leading-4 text-ink-4">
        图片版 PPTX 将生成的页面图逐页嵌入，免费导出；文字不可编辑。
      </p>
    </div>
  );
}
