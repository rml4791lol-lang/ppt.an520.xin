"use client";

// 「添加页面」弹窗（SINGLEPAGE-UI-SPEC §8）：上传图片 / 粘贴文本 双 Tab。
import { useRef, useState } from "react";
import { CloseIcon, PlusIcon, UploadIcon } from "@/components/icons";
import { Modal } from "@/components/deck/ui";
import { SP_MAX_PAGES } from "@/lib/client/single-page-store";

const IMAGE_ACCEPT = ["image/png", "image/jpeg", "image/webp"];
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface AddedPage {
  kind: "text" | "image";
  text: string;
  file?: File;
  previewUrl?: string;
}

export function AddPageModal({
  currentCount,
  onClose,
  onAdd,
}: {
  currentCount: number;
  onClose: () => void;
  onAdd: (pages: AddedPage[]) => void;
}) {
  const [tab, setTab] = useState<"image" | "text">("image");
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const remaining = SP_MAX_PAGES - currentCount;

  const pickFiles = (list: FileList | null) => {
    if (!list) return;
    const accepted: File[] = [];
    for (const file of Array.from(list)) {
      if (!IMAGE_ACCEPT.includes(file.type)) {
        setError("文件格式暂不支持（仅 PNG / JPG / WEBP）。");
        continue;
      }
      if (file.size === 0) {
        setError("文件内容为空或文件已损坏。");
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError("单张图片不能超过 15 MB。");
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length === 0) return;
    setError(null);
    setFiles((prev) => {
      const room = SP_MAX_PAGES - currentCount - prev.length;
      if (accepted.length > room) {
        setError(`本项目最多再加 ${room} 页，已忽略多出的图片`);
      }
      return [...prev, ...accepted.slice(0, Math.max(0, room))];
    });
  };

  const submit = () => {
    if (tab === "image") {
      if (files.length === 0) {
        setError("请先选择图片");
        return;
      }
      onAdd(
        files.map((file) => ({
          kind: "image" as const,
          text: "",
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      );
    } else {
      const clean = text.trim();
      if (!clean) {
        setError("请先粘贴文本");
        return;
      }
      onAdd([{ kind: "text", text: clean }]);
    }
    onClose();
  };

  const pendingCount = tab === "image" ? files.length : text.trim() ? 1 : 0;

  return (
    <Modal title="添加页面" ariaLabel="添加页面" onClose={onClose}>
      <p className="-mt-2 text-xs text-ink-3">为当前单页项目继续添加 PPT 页面</p>

      <div className="mt-4 flex gap-1 rounded-xl bg-page p-1">
        {(
          [
            { key: "image", label: "上传图片" },
            { key: "text", label: "粘贴文本" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setTab(t.key);
              setError(null);
            }}
            className={`flex-1 rounded-lg py-2 text-sm transition ${
              tab === t.key ? "bg-card font-medium text-ink shadow-card" : "text-ink-3 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "image" ? (
        <div className="mt-4">
          <div
            role="button"
            tabIndex={0}
            aria-label="上传图片"
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
              pickFiles(e.dataTransfer.files);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center transition ${
              dragOver ? "border-brand bg-brand-softer" : "border-line-strong bg-page hover:border-brand-line"
            }`}
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
              <UploadIcon width={20} height={20} />
            </span>
            <p className="mt-3 text-sm font-medium text-ink">点击上传 图片，或拖拽到此处</p>
            <p className="mt-1 text-xs text-ink-4">支持一次多张，一张图片追加一页 · 单张 ≤15MB</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={IMAGE_ACCEPT.join(",")}
            className="hidden"
            onChange={(e) => {
              pickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {files.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-ink-3">即将添加 {files.length} 页</p>
              <ul className="mt-2 space-y-1.5">
                {files.map((file, i) => (
                  <li
                    key={`${file.name}-${i}`}
                    className="flex items-center gap-2 rounded-lg bg-page px-3 py-1.5 text-xs text-ink-2"
                  >
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <span className="shrink-0 text-ink-4">{(file.size / 1024 / 1024).toFixed(1)}MB</span>
                    <button
                      type="button"
                      aria-label="移除"
                      className="shrink-0 text-ink-4 hover:text-danger"
                      onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <CloseIcon width={12} height={12} />
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mt-2 flex items-center gap-1 text-xs text-brand hover:underline"
              >
                <PlusIcon width={12} height={12} /> 继续添加
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-4">
          <textarea
            rows={7}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            placeholder="粘贴单页 PPT 需要表达的内容…"
            className="w-full resize-y rounded-xl border border-line bg-card px-3 py-2.5 text-sm leading-6 text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
          />
          <div className="mt-1.5 flex items-center justify-between text-xs text-ink-4">
            <span>已输入 {text.trim().length} 字</span>
            <span>粘贴文本每次只生成 1 页；如需长文档自动分页，请使用整套 PPT 生成。</span>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      <div className="mt-5 flex items-center justify-between">
        <span className="text-xs text-ink-4">
          {remaining <= 0
            ? `已达 ${SP_MAX_PAGES} 页上限`
            : pendingCount > 0
              ? `将追加 ${pendingCount} 页到当前项目`
              : `本项目还可添加 ${remaining} 页`}
        </span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-line-strong px-5 py-2 text-sm text-ink-2 transition hover:border-brand-line"
          >
            取消
          </button>
          <button
            type="button"
            disabled={pendingCount === 0 || remaining <= 0}
            onClick={submit}
            className="rounded-full bg-brand px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-40"
          >
            添加到当前项目
          </button>
        </div>
      </div>
    </Modal>
  );
}
