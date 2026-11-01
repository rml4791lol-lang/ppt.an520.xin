"use client";

// 首页上传面板与插件美化页签共用同一拖拽区（PLUGIN-ARCHITECTURE §2.5：插件 UI 复用壳共享组件）。
import { useRef, useState } from "react";
import { CloseIcon, FileIcon, UploadIcon } from "@/components/icons";

const MAX_FILE_SIZE = 30 * 1024 * 1024;

export function Dropzone({
  accept,
  file,
  onFile,
  title,
  hint,
  validate,
}: {
  accept: string[];
  file: File | null;
  onFile: (file: File | null) => void;
  title: string;
  hint: string;
  /** 内置格式与大小校验通过后的补充校验；返回错误文案即拒绝（如 PPTX 需先转 PDF） */
  validate?: (file: File) => string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (picked: File | undefined | null) => {
    if (!picked) return;
    const ext = `.${picked.name.split(".").pop()?.toLowerCase() ?? ""}`;
    if (!accept.includes(ext)) {
      setError(`仅支持 ${accept.join(" / ")} 格式`);
      return;
    }
    if (picked.size > MAX_FILE_SIZE) {
      setError("单文件最大 30MB");
      return;
    }
    const extraError = validate?.(picked);
    if (extraError) {
      setError(extraError);
      return;
    }
    setError(null);
    onFile(picked);
  };

  if (file) {
    return (
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
          onClick={() => onFile(null)}
        >
          <CloseIcon width={16} height={16} />
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* 真按钮承载整个拖拽区：读屏拿到的名字就是可见文案，不会再报 label-content-name-mismatch */}
      <div
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
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`flex w-full cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-14 text-center transition ${
            dragOver
              ? "border-brand bg-brand-softer"
              : "border-line-control bg-page hover:border-brand-line hover:bg-brand-softer"
          }`}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-soft text-brand">
            <UploadIcon width={22} height={22} />
          </span>
          <p className="mt-4 text-base font-semibold text-ink">{title}</p>
          <p className="mt-1.5 text-sm text-ink-3">点击此处选择文件</p>
          <p className="mt-3 text-xs leading-5 text-ink-3">{hint}</p>
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept.join(",")}
        className="hidden"
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
