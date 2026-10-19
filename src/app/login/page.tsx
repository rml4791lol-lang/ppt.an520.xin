import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { LoginCard } from "@/components/auth/login-card";
import { LoginShowcase } from "@/components/auth/login-showcase";
import { SHOWCASE_CASES } from "@/data/showcase-cases";
import { getSiteConfig } from "@/data/site-config";

export const metadata: Metadata = {
  title: "登录",
  description: "登录 AnPPT，保存作品、查看项目和使用星星。",
  alternates: { canonical: "/login" },
  robots: { index: false, follow: true },
};

export default function LoginPage() {
  const config = getSiteConfig();
  return (
    <div className="flex min-h-screen flex-col bg-page">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/brand/anppt-fish-logo.png"
            alt="AnPPT 品牌 Logo"
            width={611}
            height={414}
            className="h-8 w-auto"
            priority
          />
          <span className="text-[17px] font-semibold text-ink">AnPPT</span>
        </Link>
        <Link
          href="/"
          className="text-sm text-ink-3 transition hover:text-brand"
        >
          返回首页
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-16 pt-6">
        <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-line bg-card shadow-card lg:grid-cols-2">
          <div className="order-2 border-t border-line lg:order-1 lg:border-r lg:border-t-0">
            <LoginShowcase cases={SHOWCASE_CASES} />
          </div>
          <div className="order-1 lg:order-2">
            <Suspense>
              <LoginCard signupBonus={config.signupBonusPoints} />
            </Suspense>
          </div>
        </div>
      </main>

      <footer className="px-5 pb-6 text-center text-xs leading-6 text-ink-4 sm:px-8">
        登录即表示你同意 AnPPT 的
        <Link href="/legal/terms" className="mx-1 text-ink-3 underline-offset-2 hover:text-brand hover:underline">
          服务条款
        </Link>
        和
        <Link href="/legal/privacy" className="mx-1 text-ink-3 underline-offset-2 hover:text-brand hover:underline">
          隐私政策
        </Link>
        。遇到问题可查看
        <Link href="/help" className="mx-1 text-ink-3 underline-offset-2 hover:text-brand hover:underline">
          帮助中心
        </Link>
        。
      </footer>
    </div>
  );
}
