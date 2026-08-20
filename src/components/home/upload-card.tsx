"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  ImageIcon,
  MonitorIcon,
  PlusIcon,
  SparklesIcon,
  TrashIcon,
  UploadIcon,
} from "@/components/icons";
import { ApiClientError } from "@/lib/client/api";
import { createPagedCopyDeck, parseDeckDocument } from "@/lib/client/deck-api";
import type { StylePack } from "@/data/style-packs";

const MAX_FILE_SIZE = 30 * 1024 * 1024;
const DOC_ACCEPT = [".txt", ".md", ".pdf", ".docx"];
const PPT_ACCEPT = [".ppt", ".pptx"];
const MAX_PAGE_CHARS = 1500;

const DURATION_OPTIONS = [
  { value: "10", label: "汇报 10 分钟 · 约 7 页", pages: 7 },
  { value: "15", label: "汇报 15 分钟 · 约 10 页", pages: 10 },
  { value: "20", label: "汇报 20 分钟 · 约 13 页", pages: 13 },
  { value: "30", label: "汇报 30 分钟 · 约 20 页", pages: 20 },
];

const QUALITY_OPTIONS = [
  { value: "light", label: "轻量生图模式", note: "即将上线", disabled: true },
  { value: "standard", label: "标准生图模式 · 10🌟/页", note: null, disabled: false },
  { value: "fine", label: "精细生图模式", note: "即将上线", disabled: true },
];

type TabKey = "import" | "paged" | "beautify";

const TABS: { key: TabKey; label: string; icon: typeof FileIcon }[] = [
  { key: "import", label: "导入文档", icon: FileIcon },
  { key: "paged", label: "按页录入", icon: ImageIcon },
  { key: "beautify", label: "PPT美化", icon: MonitorIcon },
];

function Dropdown({
  value,
  options,
  onChange,
  className,
}: {
  value: string;
  options: { value: string; label: string; note?: string | null; disabled?: boolean }[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <div className={`relative ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-full border border-line bg-card px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line"
      >
        <span className="truncate">{current?.label}</span>
        <ChevronDownIcon width={14} height={14} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute z-40 mt-2 w-full min-w-52 rounded-xl border border-line bg-card p-1 shadow-pop">
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={opt.disabled}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                  opt.disabled
                    ? "cursor-not-allowed text-ink-4"
                    : opt.value === value
                      ? "bg-brand-soft font-medium text-brand"
                      : "text-ink-2 hover:bg-page"
                }`}
              >
                <span>{opt.label}</span>
                {opt.note && (
                  <span className="rounded-full bg-page px-1.5 py-0.5 text-[10px] text-ink-3">
                    {opt.note}
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Dropzone({
  accept,
  file,
  onFile,
  title,
  hint,
}: {
  accept: string[];
  file: File | null;
  onFile: (file: File | null) => void;
  title: string;
  hint: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    const ext = `.${f.name.split(".").pop()?.toLowerCase() ?? ""}`;
    if (!accept.includes(ext)) {
      setError(`仅支持 ${accept.join(" / ")} 格式`);
      return;
    }
    if (f.size > MAX_FILE_SIZE) {
      setError("单文件最大 30MB");
      return;
    }
    setError(null);
    onFile(f);
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
      <div
        role="button"
        tabIndex={0}
        aria-label={title}
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
        <p className="mt-4 text-base font-semibold text-ink">{title}</p>
        <p className="mt-1.5 text-sm text-ink-3">点击此处选择文件</p>
        <p className="mt-3 text-xs leading-5 text-ink-4">{hint}</p>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
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

function StylePicker({
  packs,
  selected,
  onSelect,
}: {
  packs: StylePack[];
  selected: StylePack | null;
  onSelect: (pack: StylePack | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full border border-line bg-card px-4 py-2 text-sm text-ink-2 transition hover:border-brand-line hover:text-brand"
      >
        <SparklesIcon width={14} height={14} />
        {selected ? `已选：${selected.name}` : "设计风格 · 可选"}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-4xl flex-col rounded-2xl bg-card p-6 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-ink">选择设计风格</h3>
              <button
                type="button"
                aria-label="关闭"
                className="rounded-full p-1 text-ink-3 hover:bg-page"
                onClick={() => setOpen(false)}
              >
                <CloseIcon width={16} height={16} />
              </button>
            </div>
            <div className="mt-4 grid flex-1 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
              {packs.map((pack) => {
                const active = selected?.id === pack.id;
                return (
                  <button
                    key={pack.id}
                    type="button"
                    onClick={() => {
                      onSelect(active ? null : pack);
                      setOpen(false);
                    }}
                    className={`group relative overflow-hidden rounded-xl border text-left transition ${
                      active
                        ? "border-brand ring-2 ring-brand/30"
                        : "border-line hover:border-brand-line"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={pack.previewUrl}
                      alt={`${pack.name} 预览图`}
                      className="aspect-[16/9] w-full object-cover"
                    />
                    <span className="block truncate px-2.5 py-2 text-xs font-medium text-ink">
                      {pack.name}
                    </span>
                    {active && (
                      <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white">
                        <CheckIcon width={11} height={11} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-ink-4">
              不选择时，AI 将按内容自动匹配推荐风格
            </p>
          </div>
        </div>
      )}
    </>
  );
}

export function UploadCard({ packs }: { packs: StylePack[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>("import");
  const [style, setStyle] = useState<StylePack | null>(null);
  const [duration, setDuration] = useState("15");
  const [quality, setQuality] = useState("standard");
  const [docFile, setDocFile] = useState<File | null>(null);
  const [pptFile, setPptFile] = useState<File | null>(null);
  const [pages, setPages] = useState<string[]>([""]);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | "import" | "paged">(null);

  // 风格卡「使用此风格」链接带 ?style={slug}：进入首页时预选该风格
  // （slug 优先，兼容 id / name），否则用户点了链接还要手动重选一遍
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("style");
    if (!value) return;
    const found = packs.find(
      (p) => p.slug === value || p.id === value || p.name === value,
    );
    if (found) setStyle(found);
  }, [packs]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  };

  // 统一错误处理：401 → 跳登录（回跳首页）；402 → 提示充值；其余直接展示文案
  const handleSubmitError = (error: unknown, fallback: string) => {
    const err = error instanceof ApiClientError ? error : null;
    if (err?.isUnauthorized) {
      router.push(`/login?next=${encodeURIComponent("/")}`);
      return;
    }
    if (err?.isInsufficientCredits) {
      flash(`${err.message}（前往「购买与兑换」充值）`);
      return;
    }
    flash(err?.message ?? fallback);
  };

  // 导入文档 → POST /api/deck/parse（FormData）→ 跳工作台
  const submitImport = async () => {
    if (!docFile) {
      flash("请先选择或拖入文档");
      return;
    }
    if (submitting) return;
    setSubmitting("import");
    try {
      const opt = DURATION_OPTIONS.find((o) => o.value === duration)!;
      const result = await parseDeckDocument({
        file: docFile,
        duration: Number(duration),
        targetPageCount: opt.pages,
        pageCountMode: "auto",
        qualityTier: quality,
        stylePackId: style?.id ?? null,
      });
      router.push(`/deck/${result.deckId}`);
    } catch (error) {
      handleSubmitError(error, "创建项目失败，请重新尝试");
      setSubmitting(null);
    }
  };

  // 按页录入 → POST /api/deck/paged-copy-v2（JSON）→ 跳工作台
  const submitPaged = async () => {
    const filled = pages.map((p) => p.trim()).filter(Boolean);
    if (filled.length === 0) {
      flash("请先至少填写一页内容");
      return;
    }
    if (submitting) return;
    setSubmitting("paged");
    try {
      const result = await createPagedCopyDeck({
        pages: filled.map((rawText) => ({ rawText })),
        qualityTier: quality,
        stylePackId: style?.id ?? null,
      });
      router.push(`/deck/${result.deckId}`);
    } catch (error) {
      handleSubmitError(error, "创建项目失败，请重新尝试");
      setSubmitting(null);
    }
  };

  // PPT 美化：后端未上线，保持占位
  const submitBeautify = () => {
    if (!pptFile) {
      flash("请先选择或拖入 PPT 文件");
      return;
    }
    flash("PPT 美化即将上线，敬请期待");
  };

  return (
    <div className="rounded-2xl border border-line bg-card p-3 shadow-card sm:p-4">
      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Tab 栏：桌面左侧纵向，移动顶部横向 */}
        <div className="flex shrink-0 gap-1 overflow-x-auto lg:w-36 lg:flex-col lg:overflow-visible">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-3 text-sm transition lg:w-full ${
                tab === t.key
                  ? "bg-brand-soft font-medium text-brand"
                  : "text-ink-3 hover:bg-page hover:text-ink"
              }`}
            >
              <t.icon width={17} height={17} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          {tab === "import" && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                <p className="text-sm text-ink-3">
                  适合已有完整文档，需要 AI 规划结构并生成整套 PPT
                </p>
                <StylePicker packs={packs} selected={style} onSelect={setStyle} />
              </div>
              <div className="mt-4">
                <Dropzone
                  accept={DOC_ACCEPT}
                  file={docFile}
                  onFile={setDocFile}
                  title="拖入文档，开始生成 PPT"
                  hint="TXT · MD · PDF · DOCX · 单文件最大 30MB · 内容上限 100,000 字"
                />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Dropdown
                  value={duration}
                  options={DURATION_OPTIONS}
                  onChange={setDuration}
                  className="w-full sm:w-auto sm:min-w-56"
                />
                <div className="flex w-full items-center gap-3 sm:ml-auto sm:w-auto">
                  <Dropdown
                    value={quality}
                    options={QUALITY_OPTIONS}
                    onChange={setQuality}
                    className="min-w-0 flex-1 sm:flex-none sm:min-w-60"
                  />
                  <button
                    type="button"
                    onClick={() => void submitImport()}
                    disabled={submitting !== null}
                    className="shrink-0 rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {submitting === "import" ? "上传解析中…" : "开始生成大纲"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === "paged" && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                <p className="text-sm text-ink-3">
                  已有逐页文案？逐页粘贴文字，AI 按你的分页直接生成
                </p>
                <StylePicker packs={packs} selected={style} onSelect={setStyle} />
              </div>
              <div className="mt-4 space-y-3">
                {pages.map((content, i) => (
                  <div
                    key={i}
                    className="rounded-2xl border border-line bg-page p-3"
                  >
                    <div className="flex items-center justify-between px-1 pb-2">
                      <span className="text-xs font-medium text-ink-3">
                        第 {i + 1} 页
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-ink-4">
                          {content.length}/{MAX_PAGE_CHARS}
                        </span>
                        {pages.length > 1 && (
                          <button
                            type="button"
                            aria-label={`删除第 ${i + 1} 页`}
                            className="rounded-md p-1 text-ink-4 hover:text-danger"
                            onClick={() =>
                              setPages((prev) => prev.filter((_, idx) => idx !== i))
                            }
                          >
                            <TrashIcon width={13} height={13} />
                          </button>
                        )}
                      </div>
                    </div>
                    <textarea
                      value={content}
                      maxLength={MAX_PAGE_CHARS}
                      rows={3}
                      placeholder={`粘贴或输入第 ${i + 1} 页的文字内容…`}
                      onChange={(e) =>
                        setPages((prev) =>
                          prev.map((p, idx) => (idx === i ? e.target.value : p)),
                        )
                      }
                      className="w-full resize-y rounded-xl border border-line bg-card px-3 py-2.5 text-sm leading-6 text-ink outline-none transition placeholder:text-ink-4 focus:border-brand-line"
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setPages((prev) => [...prev, ""])}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-strong py-2.5 text-sm text-ink-3 transition hover:border-brand-line hover:text-brand"
              >
                <PlusIcon width={14} height={14} />
                添加页面
              </button>
              <p className="mt-2 px-1 text-xs text-ink-4">
                单页上限 1,500 字 · 图片粘贴上传即将开放
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Dropdown
                  value={quality}
                  options={QUALITY_OPTIONS}
                  onChange={setQuality}
                  className="min-w-60"
                />
                <button
                  type="button"
                  onClick={() => void submitPaged()}
                  disabled={submitting !== null}
                  className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-50 sm:ml-auto"
                >
                  {submitting === "paged" ? "创建项目中…" : "开始生成"}
                </button>
              </div>
            </div>
          )}

          {tab === "beautify" && (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3 px-1">
                <p className="text-sm text-ink-3">
                  上传已有 PPT，AI 按所选风格逐页翻新美化
                </p>
                <StylePicker packs={packs} selected={style} onSelect={setStyle} />
              </div>
              <div className="mt-4">
                <Dropzone
                  accept={PPT_ACCEPT}
                  file={pptFile}
                  onFile={setPptFile}
                  title="拖入旧 PPT，一键美化翻新"
                  hint="PPT · PPTX · 单文件最大 30MB"
                />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Dropdown
                  value={quality}
                  options={QUALITY_OPTIONS}
                  onChange={setQuality}
                  className="min-w-60"
                />
                <button
                  type="button"
                  onClick={submitBeautify}
                  disabled={submitting !== null}
                  className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:opacity-50 sm:ml-auto"
                >
                  开始美化
                </button>
              </div>
            </div>
          )}

          {notice && (
            <p className="mt-3 rounded-xl bg-brand-softer px-4 py-2 text-xs text-brand">
              {notice}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
