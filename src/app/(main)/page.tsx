import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { UploadCard } from "@/components/home/upload-card";
import {
  FeatureSection,
  HomeCtaSection,
  HomeFaqSection,
  TrustSection,
  UseCaseSection,
  WorkflowSection,
} from "@/components/home/marketing-sections";
import { ShowcaseSection } from "@/components/showcase-section";
import { StylePackBrowser } from "@/components/style-pack-browser";
import { STYLE_PACK_CATEGORIES, STYLE_PACKS } from "@/data/style-packs";
import { getSiteConfig } from "@/data/site-config";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

function Hero({ signupBonusPoints }: { signupBonusPoints: number }) {
  return (
    <section className="pt-10 text-center sm:pt-14">
      <span className="inline-block rounded-full border border-brand-line bg-brand-soft px-4 py-1.5 text-[13px] font-medium text-brand">
        文档生成 · PPT 美化 · 转可编辑
      </span>
      <h1 className="mx-auto mt-6 max-w-3xl text-3xl font-bold leading-tight tracking-tight text-ink sm:text-4xl sm:leading-snug lg:text-[42px]">
        把文档，变成能讲的 PPT
      </h1>
      <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-ink-3 sm:text-[15px]">
        导入 PDF、Word、Markdown 或逐页文案，AI 先规划结构，再按设计风格生成整套页面。
        需要改字时，还可以转成可编辑 PPTX。
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="#start"
          className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
        >
          开始制作
          <ArrowRightIcon width={14} height={14} />
        </Link>
        <Link
          href="/style-packs"
          className="rounded-full border border-line bg-card px-5 py-2.5 text-sm text-ink-2 transition hover:border-brand-line hover:text-brand"
        >
          先看看模板库
        </Link>
      </div>
      <p className="mt-3 text-xs text-ink-4">
        新用户注册送 {signupBonusPoints} 🌟 · 生成失败未完成部分自动退回
      </p>
    </section>
  );
}

export default function HomePage() {
  const config = getSiteConfig();
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-0">
      <Hero signupBonusPoints={config.signupBonusPoints} />
      <div id="start" className="mt-8 scroll-mt-6">
        <UploadCard packs={STYLE_PACKS} />
      </div>

      <WorkflowSection />
      <FeatureSection />
      <UseCaseSection />

      <section className="mt-16">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold tracking-[0.16em] text-brand">STYLE LIBRARY</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              设计师原创设计风格
            </h2>
            <p className="mt-2 text-sm text-ink-3">
              风格包会影响页面视觉、配图倾向和布局规范，先选一个接近你场景的方向。
            </p>
          </div>
          <Link
            href="/style-packs"
            className="flex shrink-0 items-center gap-1 text-sm font-medium text-brand transition hover:text-brand-strong"
          >
            全部风格
            <ArrowRightIcon width={14} height={14} />
          </Link>
        </div>
        <div className="mt-6">
          <StylePackBrowser packs={STYLE_PACKS} categories={STYLE_PACK_CATEGORIES} limit={6} />
        </div>
      </section>

      <ShowcaseSection />
      <TrustSection />
      <HomeFaqSection />
      <HomeCtaSection signupBonusPoints={config.signupBonusPoints} />
    </div>
  );
}
