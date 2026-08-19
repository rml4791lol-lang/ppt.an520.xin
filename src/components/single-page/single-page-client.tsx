"use client";

import { useState } from "react";
import { CheckIcon, ImageIcon, PencilIcon, PlusIcon } from "@/components/icons";

const STEPS = ["添加内容", "选择风格", "生成结果", "下载可编辑版本"];

export function SinglePageClient() {
  const [pages, setPages] = useState<number[]>([1]);
  const [active, setActive] = useState(0);

  return (
    <div className="flex min-h-[70vh]">
      {/* 页面队列 */}
      <aside className="w-64 shrink-0 border-r border-line bg-card px-4 py-5 max-lg:hidden">
        <div className="flex items-center justify-between px-1">
          <h2 className="text-sm font-semibold text-ink">页面队列</h2>
          <span className="text-xs text-ink-4">{pages.length} 页</span>
        </div>
        <div className="mt-4 space-y-3">
          {pages.map((n, i) => (
            <button
              key={n}
              type="button"
              onClick={() => setActive(i)}
              className={`block w-full rounded-2xl border-2 p-2 text-left transition ${
                i === active ? "border-brand" : "border-line hover:border-brand-line"
              }`}
            >
              <div className="flex aspect-[16/9] items-center justify-center rounded-lg bg-page text-xs text-ink-4">
                待上传
              </div>
              <div className="mt-2 flex items-center justify-between px-1">
                <span className="text-xs font-medium text-ink">
                  Page {String(n).padStart(2, "0")}
                </span>
                <span className="text-[10px] text-ink-4">● 待上传</span>
              </div>
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPages((prev) => [...prev, prev.length + 1]);
              setActive(pages.length);
            }}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong py-2.5 text-sm text-ink-3 transition hover:border-brand-line hover:text-brand"
          >
            <PlusIcon width={14} height={14} />
            添加页面
          </button>
        </div>
      </aside>

      {/* 主区域 */}
      <div className="min-w-0 flex-1 px-5 py-5 sm:px-8">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-ink">未命名单页项目</h1>
          <button
            type="button"
            aria-label="重命名项目"
            className="text-ink-4 hover:text-ink"
            onClick={() => console.log("[AnPPT] 重命名单页项目（占位）")}
          >
            <PencilIcon width={14} height={14} />
          </button>
          <span className="flex items-center gap-1 text-xs text-emerald-600">
            <CheckIcon width={12} height={12} />
            已保存
          </span>
        </div>

        {/* 步骤条 */}
        <div className="mt-5 flex items-center gap-2 overflow-x-auto pb-1">
          {STEPS.map((label, i) => (
            <div key={label} className="flex shrink-0 items-center gap-2">
              <span
                className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-[13px] ${
                  i === 0
                    ? "bg-brand font-medium text-white"
                    : "bg-card text-ink-4"
                }`}
              >
                <span
                  className={`flex h-4.5 w-4.5 items-center justify-center rounded-full text-[11px] ${
                    i === 0 ? "bg-white/25" : "bg-page"
                  }`}
                >
                  {i + 1}
                </span>
                {label}
              </span>
              {i < STEPS.length - 1 && <span className="w-8 border-t border-line-strong" />}
            </div>
          ))}
        </div>

        {/* 空态 */}
        <div className="mt-16 flex flex-col items-center text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <ImageIcon width={24} height={24} />
          </span>
          <p className="mt-5 text-base font-semibold text-ink">这一页还没有内容</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-3">
            点击下方「添加页面」上传 PPT 原图或粘贴文本，开始生成这一页。
          </p>
          <button
            type="button"
            onClick={() => {
              setPages((prev) => [...prev, prev.length + 1]);
              setActive(pages.length);
              console.log("[AnPPT] 单页生成器添加页面（占位），完整功能将在后续阶段接入");
            }}
            className="mt-6 flex items-center gap-1.5 rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <PlusIcon width={14} height={14} />
            添加页面
          </button>
          <p className="mt-4 text-xs text-ink-4">
            支持一次上传多张图片，一张图片追加一页
          </p>
        </div>
      </div>
    </div>
  );
}
