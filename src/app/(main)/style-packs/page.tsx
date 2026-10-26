import type { Metadata } from "next";
import { TemplateLibrary } from "@/components/style-packs/template-library";
import { STYLE_PACK_CATEGORIES, STYLE_PACKS } from "@/data/style-packs";

export const metadata: Metadata = {
  title: "模板库",
  description:
    "AnPPT 模板库：官方模板灌内容，风格包借感觉；也可以用自己的 PPT 当模板做美化。",
  alternates: { canonical: "/style-packs" },
  openGraph: {
    title: "AnPPT 模板库",
    description: "设计师原创风格包与成套模板，按场景选择，快速开始制作。",
    url: "/style-packs",
  },
};

export default function StylePacksPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <h1 className="text-3xl font-bold tracking-tight text-ink">
        模板库
      </h1>
      <p className="mt-2 text-sm text-ink-3">
        模板一版找成品，风格一版找感觉；没有合适的官方模板时，用自己的 PPT 当模板做美化。
      </p>
      <div className="mt-6">
        <TemplateLibrary packs={STYLE_PACKS} categories={STYLE_PACK_CATEGORIES} />
      </div>
    </div>
  );
}
