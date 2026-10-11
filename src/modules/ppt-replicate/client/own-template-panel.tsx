"use client";

import Link from "next/link";
import { MonitorIcon, UploadIcon } from "@/components/icons";

/** 模板库第三条路线：没有合适官方模板时，用自己的 PPT 当画面模板。 */
export function OwnTemplatePanel() {
  return (
    <div className="rounded-2xl border border-line bg-card p-6 shadow-card sm:p-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-brand-soft text-brand">
          <MonitorIcon width={28} height={28} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight text-ink">用自己的 PPT 当模板</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-3">
            官方模板是灌内容；这条是保画面。把现成演示文稿当参考稿，构图和画风留下，文案换成新主题或大纲。
          </p>
          <p className="mt-2 text-xs text-ink-4">PDF 或图片 · 一次最多 40 页 · PPTX 请先另存为 PDF · 生成 10🌟/页</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">
          <Link
            href="/beautify"
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <UploadIcon width={16} height={16} />
            开始美化
          </Link>
          <Link
            href="/?tab=beautify"
            className="inline-flex items-center justify-center rounded-full border border-line-strong px-5 py-2.5 text-sm font-medium text-ink transition hover:border-brand hover:text-brand"
          >
            回首页美化页
          </Link>
        </div>
      </div>
    </div>
  );
}
