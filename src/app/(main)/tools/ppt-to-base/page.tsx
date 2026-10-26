import type { Metadata } from "next";
import { PptToBaseClient } from "@/modules/ppt-to-base/client/ppt-to-base-client";

export const metadata: Metadata = {
  title: "PPT 转模版底座",
  description: "上传一页 PPT 截图，AI 去风格化并把文字替换为中性占位词，导出通用模版底图与标题文字。",
  robots: { index: false, follow: false },
};

export default function PptToBasePage() {
  return <PptToBaseClient />;
}
