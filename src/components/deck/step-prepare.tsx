"use client";

// Step 0 上传内容：大纲生成等待屏 / 失败屏（WORKBENCH-UI-SPEC §3）。
import { useEffect, useState } from "react";
import { Spinner, WarnIcon } from "@/components/deck/ui";
import type { DeckState } from "@/lib/client/deck-api";

const ROTATING_SUBTITLES = [
  "正在读取你的文档内容...",
  "解析完成，正在识别这份材料适合的汇报类型...",
  "正在梳理整套PPT的表达主线...",
  "内容较多，AI正在继续整理，请稍后...",
];

export function StepPrepare({
  state,
  busy,
  error,
  onRetry,
}: {
  state: DeckState;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [subtitleIndex, setSubtitleIndex] = useState(0);
  const [progress, setProgress] = useState(8);

  // 副标题每 12s 轮换 + 假进度条（缓动逼近 95%）
  useEffect(() => {
    if (error) return;
    const sub = window.setInterval(
      () => setSubtitleIndex((i) => (i + 1) % ROTATING_SUBTITLES.length),
      12000,
    );
    const bar = window.setInterval(() => {
      setProgress((p) => (p < 92 ? p + Math.max(0.4, (92 - p) * 0.06) : Math.min(95, p + 0.2)));
    }, 900);
    return () => {
      window.clearInterval(sub);
      window.clearInterval(bar);
    };
  }, [error]);

  if (error && !busy) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-20">
        <div className="w-full max-w-md rounded-2xl border border-danger/20 bg-danger-soft px-8 py-10 text-center" role="alert">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-danger text-white">
            <WarnIcon width={22} height={22} />
          </span>
          <h2 className="mt-5 text-lg font-semibold text-ink">大纲生成失败</h2>
          <p className="mt-2 text-sm leading-6 text-ink-2">{error}</p>
          <p className="mt-3 text-xs leading-5 text-ink-3">
            你上传的内容已保留，重新生成不会丢失原始资料。
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-6 rounded-full bg-brand px-8 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            重新生成大纲
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-20">
      <div className="w-full max-w-lg text-center">
        <Spinner className="text-[30px]" />
        <h2 className="mt-6 text-lg font-semibold text-ink">正在生成 PPT 大纲…</h2>
        <p className="mt-2 text-sm text-ink-3">{ROTATING_SUBTITLES[subtitleIndex]}</p>

        <div className="mx-auto mt-6 h-1.5 w-64 overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-brand transition-[width] duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="mt-6 text-xs leading-5 text-ink-4">
          请保持当前页面打开，整理完成后会自动进入大纲编辑页
          <br />
          预计 1–2 分钟，请稍候
        </p>

        <dl className="mx-auto mt-8 grid max-w-md grid-cols-2 gap-3 text-left sm:grid-cols-3">
          <div className="rounded-xl border border-line bg-card px-4 py-3">
            <dt className="text-xs text-ink-4">来源文档</dt>
            <dd className="mt-1 truncate text-sm font-medium text-ink">
              {state.deck.sourceFileName || "—"}
            </dd>
          </div>
          <div className="rounded-xl border border-line bg-card px-4 py-3">
            <dt className="text-xs text-ink-4">汇报时长</dt>
            <dd className="mt-1 text-sm font-medium text-ink">{state.deck.durationMinutes} 分钟</dd>
          </div>
          <div className="rounded-xl border border-line bg-card px-4 py-3">
            <dt className="text-xs text-ink-4">目标页数</dt>
            <dd className="mt-1 text-sm font-medium text-ink">{state.deck.targetPageCount} 页</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
