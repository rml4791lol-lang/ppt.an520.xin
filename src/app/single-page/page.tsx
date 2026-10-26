import type { Metadata } from "next";
import { Suspense } from "react";
import { SinglePageClient } from "@/components/single-page/single-page-client";

export const metadata: Metadata = {
  title: "创意页面生成器",
  description: "AnPPT 创意页面生成器：上传 PPT 原图或粘贴文本，单页生成精设计配图。",
  robots: { index: false, follow: false },
};

// 独立全屏工作台（不进 (main) 侧边栏组）；useSearchParams 需要 Suspense 边界。
export default function SinglePagePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-page" />}>
      <SinglePageClient />
    </Suspense>
  );
}
