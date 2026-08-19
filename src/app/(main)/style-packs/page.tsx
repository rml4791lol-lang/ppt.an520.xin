import type { Metadata } from "next";
import { StylePackBrowser } from "@/components/style-pack-browser";
import { STYLE_PACK_CATEGORIES, STYLE_PACKS } from "@/data/style-packs";

export const metadata: Metadata = {
  title: "设计风格",
  description: "AnPPT 设计师原创设计风格库：27 套精品 PPT 风格包任你选择。",
};

export default function StylePacksPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <h1 className="text-3xl font-bold tracking-tight text-ink">
        设计师原创设计风格
      </h1>
      <p className="mt-2 text-sm text-ink-3">
        不同风格包将会影响页面视觉风格、配图倾向、布局规范等。
      </p>
      <div className="mt-6">
        <StylePackBrowser packs={STYLE_PACKS} categories={STYLE_PACK_CATEGORIES} />
      </div>
    </div>
  );
}
