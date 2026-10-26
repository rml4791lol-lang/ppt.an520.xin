"use client";

import Link from "next/link";
import { ArrowRightIcon, RefreshIcon } from "@/components/icons";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-6 py-16">
      <div className="w-full max-w-xl text-center">
        <p className="text-sm font-semibold tracking-[0.18em] text-brand">SYSTEM ERROR</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          页面暂时没能加载
        </h1>
        <p className="mt-4 text-sm leading-7 text-ink-3">
          可能是网络波动或服务短暂繁忙。你的项目和星星不会因为这次刷新丢失，可以重试或返回首页。
        </p>
        {error.digest && (
          <p className="mt-4 rounded-xl bg-card px-4 py-2 text-xs text-ink-4">
            错误编号：{error.digest}
          </p>
        )}
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <RefreshIcon width={16} height={16} />
            重新加载
          </button>
          <Link
            href="/help"
            className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-6 py-3 text-sm font-medium text-ink-2 transition hover:border-brand-line hover:text-brand"
          >
            帮助中心
            <ArrowRightIcon width={14} height={14} />
          </Link>
        </div>
      </div>
    </main>
  );
}
