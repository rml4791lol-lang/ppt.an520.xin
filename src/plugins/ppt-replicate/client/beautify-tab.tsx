"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dropzone } from "@/components/dropzone";
import { stashBeautifyFiles } from "@/modules/ppt-replicate/client/beautify-handoff";

const ACCEPT = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".ppt", ".pptx"];

/**
 * 首页「PPT美化」面板：入口与开关由 ui.entries 声明（ADR-0001 G2），
 * 组件由壳懒加载，本文件只在用户切到该页签后才进入 bundle。
 */
export function BeautifyTab() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);

  const start = () => {
    stashBeautifyFiles(file ? [file] : []);
    router.push("/beautify");
  };

  return (
    <div>
      <p className="px-1 text-sm text-ink-3">
        上传参考稿，画面跟原页，文案换成新主题或大纲
      </p>
      <div className="mt-4">
        <Dropzone
          accept={ACCEPT}
          file={file}
          onFile={setFile}
          title="拖入 PDF 或图片，开始美化"
          hint="PDF · PNG · JPG · WebP · 单文件最大 30MB · PPTX 请先另存 PDF"
          ariaLabel="上传参考稿"
          validate={(picked) => (/.pptx?$/i.test(picked.name) ? "PPTX 请先另存为 PDF 再上传" : null)}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={start}
          className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong sm:ml-auto"
        >
          开始美化
        </button>
      </div>
      <p className="mt-2 px-1 text-xs text-ink-4">
        不选文件也可进入工作台。生成与转可编辑均按页计费，进入工作台后可看到实际单价。
      </p>
    </div>
  );
}
