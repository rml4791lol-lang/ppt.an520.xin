import type { Metadata } from "next";
import { OnlyOfficeClient } from "@/components/tools/onlyoffice-client";

export const metadata: Metadata = {
  title: "免费 PPT 编辑器下载：ONLYOFFICE 桌面版用来做什么",
  description:
    "这里下载的是第三方开源免费的 ONLYOFFICE Desktop Editors，用来在本地打开并继续编辑 AnPPT 导出的可编辑 PPTX：改字、调版式、放映、导出 PDF。任意充值一次，永久解锁三个 Windows 安装包、版本校验与兼容工具包。",
  robots: { index: false, follow: false },
};

export default function OnlyOfficePage() {
  return <OnlyOfficeClient />;
}
