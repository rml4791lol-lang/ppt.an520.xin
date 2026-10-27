"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CloseIcon, FileIcon, UploadIcon } from "@/components/icons";
import { stashBeautifyFiles } from "@/modules/ppt-replicate/client/beautify-handoff";

const ACCEPT = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".ppt", ".pptx"];
const MAX_FILE_SIZE = 30 * 1024 * 1024;

/**
 * 首页「PPT美化」面板：入口与开关由 ui.entries 声明（ADR-0001 G2），
 * 组件由壳懒加载，本文件只在用户切到该页签后才进入 bundle。
 */
export function BeautifyTab() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (picked: File | undefined | null) => {
    if (!picked) return;
    const ext = `.${picked.name.split(".").pop()?.toLowerCase() ?? ""}`;
    if (!ACCEPT.includes(ext)) {
      setError(`仅支持 ${ACCEPT.join(" / ")} 格式`);
      return;
    }
    if (picked.size > MAX_FILE_SIZE) {
      setError("单文件最大 30MB");
      return;
    }
    if (/\.pptx?$/i.test(picked.name)) {
      setError("PPTX 请先另存为 PDF 再上传");
      return;
    }
    setError(null);
    setFile(picked);
  };

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
        {file ? (
          <div className="flex items-center justify-between rounded-2xl border border-brand-line bg-brand-softer px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                <FileIcon width={18} height={18} />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{file.name}</p>
                <p className="text-xs text-ink-3">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label="移除文件"
              className="rounded-full p-1.5 text-ink-3 hover:bg-card hover:text-ink"
              onClick={() => setFile(null)}
            >
              <CloseIcon width={16} height={16} />
            </button>
          </div>
        ) : (
          <div>
            <div
              role="button"
              tabIndex={0}
              aria-label="上传参考稿"
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pick(e.dataTransfer.files?.[0]);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-14 text-center transition ${
                dragOver
                  ? "border-brand bg-brand-softer"
                  : "border-line-strong bg-page hover:border-brand-line hover:bg-brand-softer"
              }`}
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                <UploadIcon width={22} height={22} />
              </span>
              <p className="mt-4 text-base font-semibold text-ink">拖入 PDF 或图片，开始美化</p>
              <p className="mt-1.5 text-sm text-ink-3">点击此处选择文件</p>
              <p className="mt-3 text-xs leading-5 text-ink-4">
                PDF · PNG · JPG · WebP · 单文件最大 30MB · PPTX 请先另存 PDF
              </p>
            </div>
            {error && <p className="mt-2 text-xs text-danger">{error}</p>}
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT.join(",")}
              className="hidden"
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        )}
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
        不选文件也可进入工作台。生成 10🌟/页，转可编辑另计 20🌟/页。
      </p>
    </div>
  );
}
