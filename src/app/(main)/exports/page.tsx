import type { Metadata } from "next";
import { ExportsClient } from "./exports-client";

export const metadata: Metadata = {
  title: "下载中心",
  description: "AnPPT 下载中心：导出的图片版 / 可编辑 PPTX 都会出现在这里，可随时再次下载。",
  robots: { index: false, follow: false },
};

export default function ExportsPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-0">
      <p className="text-sm font-medium text-brand">创作空间</p>
      <div className="mt-2">
        <h1 className="text-3xl font-bold tracking-tight text-ink">下载中心</h1>
        <p className="mt-2 text-sm text-ink-3">
          导出的 PPT 文件都会保留在这里，可随时再次下载；可编辑转换完成后会自动出现在列表中。
        </p>
      </div>

      <div className="mt-8">
        <ExportsClient />
      </div>
    </div>
  );
}
