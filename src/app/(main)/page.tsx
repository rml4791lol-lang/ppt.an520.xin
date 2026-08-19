import Link from "next/link";
import { ArrowRightIcon } from "@/components/icons";
import { UploadCard } from "@/components/home/upload-card";
import { ShowcaseSection } from "@/components/showcase-section";
import { StylePackBrowser } from "@/components/style-pack-browser";
import { STYLE_PACK_CATEGORIES, STYLE_PACKS } from "@/data/style-packs";

function Hero() {
  return (
    <section className="pt-10 text-center sm:pt-14">
      <span className="inline-block rounded-full border border-brand-line bg-brand-soft px-4 py-1.5 text-[13px] font-medium text-brand">
        生成图片版PPT · 支持转可编辑
      </span>
      <h1 className="mt-6 text-3xl font-bold leading-tight tracking-tight text-ink sm:text-4xl sm:leading-snug">
        专业PPT设计机构出品
        <br />
        顶尖图片生成AI模型加持
      </h1>
      <div className="mt-6 flex items-center justify-center gap-2">
        <span className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white">
          图片生成模式
        </span>
        <span
          className="cursor-not-allowed rounded-full bg-card px-5 py-2 text-sm text-ink-4"
          title="Agent 模式即将上线"
          aria-disabled
        >
          Agent模式
        </span>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-0">
      <Hero />
      <div className="mt-8">
        <UploadCard packs={STYLE_PACKS} />
      </div>

      <section className="mt-16">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-ink">
              设计师原创设计风格
            </h2>
            <p className="mt-2 text-sm text-ink-3">
              不同风格包将会影响页面视觉风格、配图倾向、布局规范等。
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
          <StylePackBrowser packs={STYLE_PACKS} categories={STYLE_PACK_CATEGORIES} />
        </div>
      </section>

      <ShowcaseSection />
    </div>
  );
}
