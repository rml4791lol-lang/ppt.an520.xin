"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, DownloadIcon, FileIcon, ImageIcon, UploadIcon } from "@/components/icons";
import { getExportRecord, listExportRecords, type ExportRecord } from "@/lib/client/deck-api";

const ACCEPTED = ["application/pdf", "image/png", "image/jpeg"];
const MAX_FILES = 20;

const STAGES: Record<string, string> = {
  queued: "任务已排队",
  preparing: "正在检查文件",
  "building-pdf": "正在整理页面顺序",
  uploading: "正在安全上传",
  waiting: "小安正在把每一页拆成可编辑元素",
  converting: "文字、图形和表格正在认真归位",
  downloading: "转换完成，正在保存到下载中心",
  completed: "已完成",
  failed: "转换失败",
};

interface StartPayload {
  exportId: string;
  status: "processing" | "succeeded";
  credits: number;
  pageCount: number;
  progress: number;
  completedPages: number;
  totalPages: number;
  stage: string;
  url: string;
  reused: boolean;
}

function startToRecord(started: StartPayload): ExportRecord {
  const now = Date.now();
  return {
    exportId: started.exportId,
    refType: "upload",
    refId: "",
    kind: "editable",
    status: started.status,
    pageCount: started.pageCount,
    progress: started.progress,
    completedPages: started.completedPages,
    totalPages: started.totalPages,
    stage: started.stage,
    url: started.url,
    error: "",
    chargedCredits: started.credits,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: started.status === "succeeded" ? now : 0,
    isCurrentSource: true,
  };
}

function humanSize(size: number): string {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function messageFrom(json: unknown, fallback: string): string {
  if (!json || typeof json !== "object") return fallback;
  const body = json as { error?: { message?: string }; message?: string };
  return body.error?.message || body.message || fallback;
}

export function EditableConverterClient() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [record, setRecord] = useState<ExportRecord | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json().catch(() => null))
      .then((session) => {
        const authenticated = Boolean(session?.ok && session.data?.authenticated);
        if (!cancelled) setLoggedIn(authenticated);
        if (cancelled || !authenticated) return null;
        return listExportRecords(1, 1, { refType: "upload", kind: "editable", latest: true });
      })
      .then((result) => {
        if (!cancelled && result?.items[0]) setRecord(result.items[0]);
      })
      .catch(() => {
        if (!cancelled) setLoggedIn(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const running = record?.status === "pending" || record?.status === "processing";
  useEffect(() => {
    if (!running || !record?.exportId) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await getExportRecord(record.exportId);
        if (cancelled) return;
        setRecord(next);
        if (next.status === "succeeded") {
          setNotice("可编辑 PPTX 已放入下载中心。好作品值得多检查一遍。");
          return;
        }
        if (next.status === "failed") {
          setError(next.error || "服务器刚刚开了个小差，星星已退回；稍后可继续转换。");
          return;
        }
      } catch {
        // 网络抖动不打断后台任务，下轮继续读取。
      }
      if (!cancelled) timer = window.setTimeout(poll, 4000);
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [record?.exportId, running]);

  const addFiles = useCallback((incoming: File[]) => {
    setError("");
    setNotice("");
    setRecord(null);
    const supported = incoming.filter((file) => ACCEPTED.includes(file.type) || /\.(pdf|png|jpe?g)$/i.test(file.name));
    if (supported.length !== incoming.length) {
      setError("仅支持 PDF、PNG、JPG 和 JPEG 文件。");
    }
    if (supported.length === 0) return;
    const hasPdf = supported.some((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    if (hasPdf) {
      if (supported.length > 1) setError("PDF 请单独上传；多张图片可一次上传并按列表顺序转换。");
      setFiles([supported.find((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name))!]);
      return;
    }
    setFiles((current) => {
      const imagesOnly = current.filter((file) => file.type !== "application/pdf" && !/\.pdf$/i.test(file.name));
      return [...imagesOnly, ...supported].slice(0, MAX_FILES);
    });
  }, []);

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files || []));
    event.target.value = "";
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files || []));
  };

  const totalSize = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const start = async (force = false) => {
    if (loggedIn === false) {
      router.push("/login?next=%2Ftools%2Feditable-converter");
      return;
    }
    if (loggedIn === null || files.length === 0 || submitting || running) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    const form = new FormData();
    files.forEach((file) => form.append("files", file));
    form.set("force", String(force));
    try {
      const response = await fetch("/api/editable-conversions", {
        method: "POST",
        headers: { "x-anppt-action": "1" },
        body: form,
      });
      const json = await response.json().catch(() => null);
      if (response.status === 401) {
        router.push("/login?next=%2Ftools%2Feditable-converter");
        return;
      }
      if (!response.ok || !json?.ok) {
        setError(messageFrom(json, "服务器刚刚开了个小差，请稍后再试。"));
        return;
      }
      const started = json.data as StartPayload;
      setRecord(startToRecord(started));
      if (started.status === "succeeded") {
        setNotice(started.reused ? "已找到同一文件的转换结果，本次没有重复扣星。" : "转换已完成。");
      } else {
        setNotice(
          started.reused
            ? "已恢复同一文件的后台任务，没有重复扣星；完成后可在下载中心查看。"
            : `已识别 ${started.pageCount} 页并开始后台转换，本次使用 ${started.credits} 🌟；可以安全离开。`,
        );
      }
    } catch {
      setError("网络暂时不可用，请稍后再试。已提交的任务可在下载中心继续查看。");
    } finally {
      setSubmitting(false);
    }
  };

  const move = (index: number, offset: number) => {
    setFiles((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const progress = record?.status === "succeeded" ? 100 : Math.max(2, record?.progress || 2);
  const sourceIsPdf = files.length === 1 && (files[0]?.type === "application/pdf" || /\.pdf$/i.test(files[0]?.name || ""));

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-0">
      <div className="text-center">
        <span className="inline-flex rounded-full bg-brand-soft px-3 py-1 text-xs font-medium text-brand">PDF / 图片 → 可编辑 PPTX</span>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-ink sm:text-4xl">把现有页面，重新变成可编辑元素</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-7 text-ink-3">
          上传 1 份 PDF，或按顺序上传最多 20 张 PNG/JPG 图片。后台完成后，文件会自动进入下载中心。
        </p>
      </div>

      <section className="mt-9 rounded-[28px] border border-line bg-card p-5 shadow-card sm:p-8">
        <div
          role="button"
          tabIndex={0}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex min-h-56 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition ${
            dragging ? "border-brand bg-brand-soft" : "border-line-strong bg-page hover:border-brand-line"
          }`}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-card text-brand shadow-card">
            <UploadIcon width={22} height={22} />
          </span>
          <p className="mt-4 font-semibold text-ink">拖入文件，或点击选择</p>
          <p className="mt-2 text-xs leading-5 text-ink-4">PDF 单独上传 · PNG/JPG 可多选 · 合计不超过 30MB</p>
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            multiple
            className="sr-only"
            onChange={onInput}
          />
        </div>

        {files.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm font-medium text-ink">已选择 {files.length} 个文件</p>
              <button type="button" className="text-xs text-ink-4 hover:text-danger" onClick={() => setFiles([])}>清空</button>
            </div>
            <ol className="mt-3 space-y-2">
              {files.map((file, index) => (
                <li key={`${file.name}-${file.size}-${index}`} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5">
                  <span className="text-brand">{sourceIsPdf ? <FileIcon width={17} height={17} /> : <ImageIcon width={17} height={17} />}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-2"><span className="mr-2 text-ink-4">{index + 1}.</span>{file.name}</span>
                  <span className="shrink-0 text-xs text-ink-4">{humanSize(file.size)}</span>
                  {!sourceIsPdf && files.length > 1 && (
                    <span className="flex shrink-0 gap-1">
                      <button type="button" aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} className="rounded px-1.5 text-xs text-ink-3 disabled:opacity-25">↑</button>
                      <button type="button" aria-label="下移" disabled={index === files.length - 1} onClick={() => move(index, 1)} className="rounded px-1.5 text-xs text-ink-3 disabled:opacity-25">↓</button>
                    </span>
                  )}
                  <button type="button" aria-label={`移除 ${file.name}`} onClick={() => setFiles((current) => current.filter((_, i) => i !== index))} className="shrink-0 text-xs text-ink-4 hover:text-danger">移除</button>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-right text-xs text-ink-4">合计 {humanSize(totalSize)}</p>
          </div>
        )}

        {error && <p className="mt-5 rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger">{error}</p>}
        {notice && <p className="mt-5 rounded-xl bg-brand-soft px-4 py-3 text-sm text-brand">{notice}</p>}

        {record && (running || record.status === "succeeded" || record.status === "failed") && (
          <div className="mt-5 rounded-2xl border border-line bg-page p-4" aria-live="polite">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="font-medium text-ink">{STAGES[record.stage] || (running ? "转换中" : record.status === "succeeded" ? "已完成" : "转换失败")}</span>
              <span className="text-ink-3">{record.completedPages > 0 ? `${record.completedPages}/${record.totalPages || record.pageCount} 页` : `${Math.round(record.progress || 0)}%`}</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-brand-soft">
              <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${progress}%` }} />
            </div>
            {running && <p className="mt-3 text-xs text-ink-4">可以安全刷新或离开，后台不会重复提交；完成后可在下载中心看到。</p>}
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-5 text-ink-4">20 🌟/页；服务器识别真实页数后一次扣除。重复提交同一文件会复用任务，不重复扣星。</p>
          {record?.status === "succeeded" && record.url ? (
            <a href={record.url} download className="inline-flex justify-center gap-2 rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white">
              <DownloadIcon width={16} height={16} /> 下载可编辑 PPTX
            </a>
          ) : (
            <button
              type="button"
              disabled={loggedIn === null || files.length === 0 || submitting || running}
              onClick={() => void start(record?.status === "failed")}
              className="rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong disabled:cursor-not-allowed disabled:opacity-45"
            >
              {running
                ? "后台转换中"
                : submitting
                  ? "正在提交…"
                  : loggedIn === null
                    ? "正在确认账号…"
                    : loggedIn === false
                      ? "登录后开始转换"
                      : record?.status === "failed"
                        ? "重新转换"
                        : "开始转换"}
            </button>
          )}
        </div>
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        {[
          [CheckIcon, "元素级可编辑", "尽可能重建文字、形状、图片与页面层级。"],
          [UploadIcon, "后台处理", "不用停留在页面，刷新也能从原任务继续。"],
          [DownloadIcon, "统一下载中心", "转换结果可反复下载，不因刷新重复转换。"],
        ].map(([Icon, title, text]) => {
          const ItemIcon = Icon as typeof CheckIcon;
          return (
            <article key={String(title)} className="rounded-2xl border border-line bg-card p-5 shadow-card">
              <ItemIcon width={18} height={18} />
              <h2 className="mt-3 text-sm font-semibold text-ink">{String(title)}</h2>
              <p className="mt-1.5 text-xs leading-5 text-ink-3">{String(text)}</p>
            </article>
          );
        })}
      </section>

      <p className="mt-8 text-center text-xs text-ink-4">转换效果受源文件清晰度和排版复杂度影响。需要继续修改时，可前往 <Link href="/tools/onlyoffice" className="font-medium text-brand">免费 PPT 编辑器</Link>。</p>
    </div>
  );
}
