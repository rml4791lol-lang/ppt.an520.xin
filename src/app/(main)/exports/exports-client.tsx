"use client";

// 下载中心：GET /api/pptx-exports 列表；有 pending/processing 记录时 4s 自动刷新。
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PlusIcon } from "@/components/icons";
import { DownloadIcon, Spinner } from "@/components/deck/ui";
import { listExportRecords, type ExportRecord } from "@/lib/client/deck-api";

function statusChip(item: ExportRecord) {
  if (item.status === "succeeded") {
    return <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-600">已完成</span>;
  }
  if (item.status === "failed") {
    return (
      <span
        className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] text-danger"
        title={item.error || undefined}
      >
        失败
      </span>
    );
  }
  return (
    <span className="flex items-center rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand">
      <Spinner className="mr-1 text-[9px]" />
      转换中
    </span>
  );
}

export function ExportsClient() {
  const [items, setItems] = useState<ExportRecord[] | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setUnauthorized(false);
    try {
      const data = await listExportRecords();
      setItems(data.items);
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status: number }).status === 401) {
        setUnauthorized(true);
        setItems(null);
      }
      // 其余失败保持现有列表，下轮自动刷新再试
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 有转换中的记录时 4s 自动刷新
  const hasRunning = (items ?? []).some((item) => item.status === "pending" || item.status === "processing");
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [hasRunning, load]);

  return (
    <div className="space-y-5">
      {unauthorized && (
        <div className="flex items-center justify-between rounded-2xl border border-danger/20 bg-danger-soft px-5 py-4">
          <p className="text-sm text-danger">请先登录后再操作</p>
          <Link
            href="/login?next=%2Fexports"
            className="rounded-full bg-dark px-4 py-1.5 text-xs font-medium text-white"
          >
            去登录
          </Link>
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-line bg-card px-6 py-24 text-center text-sm text-ink-3 shadow-card">
          加载中…
        </div>
      ) : items && items.length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-card">
          <div className="hidden grid-cols-[1fr_88px_64px_96px_96px] gap-3 border-b border-line bg-page px-5 py-2.5 text-xs text-ink-4 sm:grid">
            <span>时间</span>
            <span>类型</span>
            <span>页数</span>
            <span>状态</span>
            <span className="text-right">操作</span>
          </div>
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li
                key={item.exportId}
                className="grid grid-cols-1 gap-2 px-5 py-3.5 text-sm sm:grid-cols-[1fr_88px_64px_96px_96px] sm:items-center sm:gap-3"
              >
                <span className="text-ink-2">
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                  {item.status === "failed" && item.error && (
                    <span className="mt-0.5 block truncate text-xs text-danger" title={item.error}>
                      {item.error}
                    </span>
                  )}
                </span>
                <span className="text-ink-3">{item.kind === "editable" ? "可编辑" : "图片版"}</span>
                <span className="text-ink-3">{item.pageCount} 页</span>
                <span>{statusChip(item)}</span>
                <span className="sm:text-right">
                  {item.status === "succeeded" && item.url ? (
                    <a
                      href={item.url}
                      download
                      className="inline-flex items-center gap-1 rounded-full border border-line-strong px-3 py-1 text-xs text-ink-2 transition hover:border-brand-line hover:text-brand"
                    >
                      <DownloadIcon width={12} height={12} /> 下载
                    </a>
                  ) : (
                    <span className="text-xs text-ink-4">{item.status === "failed" ? "不可用" : "待完成"}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-2xl border border-line bg-card px-6 py-24 text-center shadow-card">
          <p className="text-base font-semibold text-ink">还没有导出记录</p>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-ink-3">
            在工作台生成页面后，可导出图片版 PPT（免费）或转可编辑 PPTX，导出文件会出现在这里。
          </p>
          <Link
            href="/projects"
            className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-brand px-6 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
          >
            <PlusIcon width={14} height={14} />
            去我的项目
          </Link>
        </div>
      )}
    </div>
  );
}
