import type { Metadata } from "next";
import { Suspense } from "react";
import { BeautifyClient } from "@/modules/ppt-replicate/client/beautify-client";

export const metadata: Metadata = {
  title: "PPT 美化",
  description: "上传参考稿，画面跟原页，文案换成你的主题或大纲。",
  robots: { index: false, follow: false },
};

export default function BeautifyPage() {
  return (
    <Suspense fallback={<p className="py-20 text-center text-sm text-ink-3">正在打开 PPT 美化…</p>}>
      <BeautifyClient />
    </Suspense>
  );
}
