import type { Metadata } from "next";
import { TemplateLibrary } from "@/components/style-packs/template-library";
import { STYLE_PACK_CATEGORIES, STYLE_PACKS } from "@/data/style-packs";

export const metadata: Metadata = {
  title: "模板库",
  description:
    "AnPPT 模板库：模板一版找成品（内容灌进现成版式），风格一版找感觉（只借鉴视觉风格），按赛事、赛道、颜色、风格、题材快速定位。",
};

export default function StylePacksPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <h1 className="text-3xl font-bold tracking-tight text-ink">
        模板库
      </h1>
      <p className="mt-2 text-sm text-ink-3">
        模板一版找成品（内容灌进现成版式），风格一版找感觉（只借鉴视觉风格）。
      </p>
      <div className="mt-6">
        <TemplateLibrary packs={STYLE_PACKS} categories={STYLE_PACK_CATEGORIES} />
      </div>
    </div>
  );
}
