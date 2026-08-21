"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getExportRecord,
  getLatestEditableExport,
  type EditableExportStart,
  type ExportRecord,
} from "@/lib/client/deck-api";

const WAITING_COPY = [
  "小安正在把每一页拆成可编辑元素…",
  "版式正在逐页归位，完成后会自动放进下载中心。",
  "文字、图形和表格正在认真排队…",
  "好作品值得多检查一遍。",
] as const;

const STAGE_LABELS: Record<string, string> = {
  queued: "等待开始",
  preparing: "整理页面素材",
  "building-pdf": "打包页面",
  uploading: "上传转换素材",
  waiting: "等待转换服务处理",
  pending: "等待转换服务处理",
  converting: "逐页识别并重建",
  processing: "逐页识别并重建",
  saving: "整理转换结果",
  downloading: "保存可编辑文件",
  completed: "转换完成",
  failed: "转换未完成",
};

type Toast = (
  text: string,
  opts?: { actionLabel?: string; onAction?: () => void; duration?: number },
) => void;

interface UseEditableExportOptions {
  refType: "deck" | "single-page";
  refId: string | null;
  title: string;
  startRequest: (force: boolean) => Promise<EditableExportStart>;
  toast: Toast;
  onCreditsChanged?: () => void;
}

function recordFromStart(
  started: EditableExportStart,
  refType: "deck" | "single-page",
  refId: string,
): ExportRecord {
  const now = Date.now();
  return {
    exportId: started.exportId,
    refType,
    refId,
    kind: "editable",
    status: started.status,
    pageCount: started.pageCount,
    progress: started.progress,
    completedPages: started.completedPages,
    totalPages: started.totalPages || started.pageCount,
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

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function useEditableExport({
  refType,
  refId,
  title,
  startRequest,
  toast,
  onCreditsChanged,
}: UseEditableExportOptions) {
  const [record, setRecord] = useState<ExportRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copyIndex, setCopyIndex] = useState(0);
  const activeSeenRef = useRef<Set<string>>(new Set());
  const terminalNotifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!refId) {
        setRecord(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      getLatestEditableExport(refType, refId)
        .then((latest) => {
          if (cancelled) return;
          setRecord(latest);
          if (latest && (latest.status === "pending" || latest.status === "processing")) {
            activeSeenRef.current.add(latest.exportId);
          }
        })
        .catch(() => {
          // 登录态/网络抖动不阻塞页面主流程；提交时仍会给出明确错误。
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refId, refType]);

  const running = record?.status === "pending" || record?.status === "processing";

  useEffect(() => {
    if (!record?.exportId || !running) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const next = await getExportRecord(record.exportId);
        if (cancelled) return;
        setRecord(next);
        const terminal = next.status === "succeeded" || next.status === "failed";
        if (terminal && activeSeenRef.current.has(next.exportId) && !terminalNotifiedRef.current.has(next.exportId)) {
          terminalNotifiedRef.current.add(next.exportId);
          if (next.status === "succeeded") {
            toast("可编辑 PPTX 已转换完成，已放入下载中心。好作品值得多检查一遍。", {
              actionLabel: "立即下载",
              onAction: () => triggerDownload(next.url, `${title || "PPT"}-可编辑.pptx`),
              duration: 10_000,
            });
          } else {
            toast(next.error || "服务器刚刚开了个小差，星星已退回；稍后可继续转换。", { duration: 8000 });
            onCreditsChanged?.();
          }
        }
        if (!terminal) timer = window.setTimeout(poll, 4000);
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 4000);
      }
    };
    timer = window.setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [onCreditsChanged, record?.exportId, running, title, toast]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setCopyIndex((index) => (index + 1) % WAITING_COPY.length), 8000);
    return () => window.clearInterval(timer);
  }, [running]);

  const start = useCallback(async (force = false) => {
    if (!refId || submitting) return null;
    setSubmitting(true);
    try {
      const started = await startRequest(force);
      const next = recordFromStart(started, refType, refId);
      setCopyIndex(0);
      setRecord(next);
      if (started.status === "succeeded" && started.url) {
        toast(
          started.reused
            ? "已找到同一版本的可编辑文件，本次没有重复扣星。"
            : "可编辑文件已完成，可在下载中心查看。",
          {
            actionLabel: "立即下载",
            onAction: () => triggerDownload(started.url, `${title || "PPT"}-可编辑.pptx`),
            duration: 8000,
          },
        );
      } else {
        activeSeenRef.current.add(started.exportId);
        toast(
          started.reused
            ? "转换仍在后台进行，已恢复原任务；可以安全刷新或离开，完成后可在下载中心查看。"
            : "已开始后台转换；可以安全刷新或离开，完成后可在下载中心查看。",
          { duration: 9000 },
        );
      }
      if (started.credits > 0) onCreditsChanged?.();
      return started;
    } finally {
      setSubmitting(false);
    }
  }, [onCreditsChanged, refId, refType, startRequest, submitting, title, toast]);

  const succeeded = Boolean(
    record?.status === "succeeded" && record.url && record.isCurrentSource !== false,
  );
  const progressLabel = useMemo(() => {
    if (!record) return "";
    const total = record.totalPages || record.pageCount;
    if (running && record.completedPages > 0 && total > 0) {
      return `已完成 ${Math.min(record.completedPages, total)} / ${total} 页`;
    }
    return STAGE_LABELS[record.stage] || (running ? "转换中" : "");
  }, [record, running]);

  const download = useCallback(() => {
    if (!record?.url) return;
    triggerDownload(record.url, `${title || "PPT"}-可编辑.pptx`);
  }, [record, title]);

  return {
    record,
    loading,
    submitting,
    running,
    succeeded,
    progressLabel,
    waitingCopy: WAITING_COPY[running ? copyIndex : 0],
    start,
    download,
  };
}
