import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, HomeIcon } from "@/components/icons";

export const metadata: Metadata = {
  title: "页面不存在",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-6 py-16">
      <div className="w-full max-w-xl text-center">
        <p className="text-sm font-semibold tracking-[0.18em] text-brand">404</p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          这个页面不存在
        </h1>
        <p className="mt-4 text-sm leading-7 text-ink-3">
          链接可能已经失效，或者地址输入有误。你可以回到首页重新开始，也可以到帮助中心查找使用说明。
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <HomeIcon width={16} height={16} />
            返回首页
          </Link>
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
