import type { Metadata } from "next";
import { OnlyOfficeClient } from "@/components/tools/onlyoffice-client";

export const metadata: Metadata = {
  title: "免费 PPT 编辑器与会员下载",
  description: "任意充值一次，永久解锁 ONLYOFFICE 三个 Windows 安装包、版本校验与 AnPPT 兼容服务。",
};

export default function OnlyOfficePage() {
  return <OnlyOfficeClient />;
}
