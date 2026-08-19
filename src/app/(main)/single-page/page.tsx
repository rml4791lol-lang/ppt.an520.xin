import type { Metadata } from "next";
import { SinglePageClient } from "@/components/single-page/single-page-client";

export const metadata: Metadata = {
  title: "创意页面生成器",
  description: "AnPPT 创意页面生成器：上传 PPT 原图或粘贴文本，单页生成精设计配图。",
};

export default function SinglePagePage() {
  return <SinglePageClient />;
}
