"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertIcon, ChevronLeftIcon, RefreshIcon } from "@/components/icons";
import { apiFetch } from "@/lib/client/api";

interface ProblemItem {
  ts: number;
  level: "error" | "warn";
  category: string;
  message: string;
  detail: string;
  userId: string;
  refType: string;
  refId: string;
  eventId?: string;
  requestId?: string;
  method?: string;
  route?: string;
  release?: string;
}

interface ProblemHealth {
  ok: boolean;
  writable: boolean;
  fileCount: number;
  totalBytes: number;
  writeFailures: number;
  lastFailureAt: number;
  recentFailure: boolean;
  retentionDays: number;
}

interface ProblemPage {
  items: ProblemItem[];
  categories: string[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  scanLimited: boolean;
  health: ProblemHealth;
}

const CATEGORY_LABELS: Record<string, string> = {
  api: "接口异常",
  generation: "生成/退款",
  "image-upstream": "生图上游",
  editable: "可编辑导出",
  "ppt-to-base": "模版底座",
  payments: "支付回调",
  otp: "验证码",
  sms: "短信",
};

const LEVEL_LABEL: Record<string, string> = { error: "错误", warn: "警告" };

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(ts);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function fetchProblems(query: string): Promise<ProblemPage> {
  return apiFetch<ProblemPage>(`/api/admin/problems?${query}`);
}

export function ProblemsClient({ admin }: { admin: { displayName: string } }) {
  const [days, setDays] = useState("3");
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [items, setItems] = useState<ProblemItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [scanLimited, setScanLimited] = useState(false);
  const [health, setHealth] = useState<ProblemHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);

  const load = useCallback(async (offset: number, append: boolean) => {
    const sequence = ++requestSequence.current;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setItems([]);
      setCategories([]);
      setTotal(0);
      setHasMore(false);
      setScanLimited(false);
    }
    const params = new URLSearchParams({ days, limit: "200", offset: String(offset) });
    if (category) params.set("category", category);
    if (level) params.set("level", level);
    try {
      const page = await fetchProblems(params.toString());
      if (sequence !== requestSequence.current) return;
      setItems((previous) => (append ? [...previous, ...page.items] : page.items));
      setCategories(page.categories);
      setTotal(page.total);
      setHasMore(page.hasMore);
      setNextOffset(page.nextOffset);
      setScanLimited(page.scanLimited);
      setHealth(page.health);
      setError("");
    } catch (loadError) {
      if (sequence === requestSequence.current) {
        setError(loadError instanceof Error ? loadError.message : "问题日志加载失败");
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [category, days, level]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(0, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const categoryOptions = Array.from(new Set([...(category ? [category] : []), ...categories]));

  return (
    <div className="pb-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-10">
        <section className="relative overflow-hidden rounded-3xl border border-brand-line bg-gradient-to-br from-[#fff7f1] via-white to-[#fffaf6] px-5 py-6 shadow-card sm:px-8">
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-brand">
                <AlertIcon width={15} height={15} />
                AnPPT Problem Log
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">问题日志</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-2">
                站点关键失败的结构化记录（接口异常、生成退款、上游失败、支付回调、验证码交付等）。每条记录带请求号与发布版本，便于多人并行排查；落盘失败不影响业务。
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span className="rounded-full border border-line bg-white px-2.5 py-1">管理员：{admin.displayName}</span>
                <span className="rounded-full border border-line bg-white px-2.5 py-1">
                  共 {scanLimited ? "≥" : ""}{total} 条
                </span>
                <span className={`rounded-full border px-2.5 py-1 ${health?.ok ? "border-emerald-200 bg-emerald-50 text-emerald-700" : health ? "border-red-200 bg-red-50 text-red-700" : "border-line bg-white"}`}>
                  {health ? (health.ok ? "落盘正常" : "落盘异常") : "落盘检查中"}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/admin"
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3.5 text-sm font-medium text-ink-2 transition hover:text-ink"
              >
                <ChevronLeftIcon width={15} height={15} />
                系统管理
              </Link>
              <button
                type="button"
                disabled={loading}
                onClick={() => void load(0, false)}
                className="flex h-10 items-center justify-center gap-2 rounded-xl bg-dark px-4 text-sm font-medium text-white transition hover:bg-ink disabled:opacity-60"
              >
                <RefreshIcon width={16} height={16} className={loading ? "animate-spin" : ""} />
                {loading ? "读取中" : "刷新"}
              </button>
            </div>
          </div>
        </section>

        <section className="mt-5 overflow-hidden rounded-2xl border border-line bg-card shadow-card">
          <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:px-6">
            <label className="flex items-center gap-2 text-xs text-ink-3">
              类别
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none transition focus:border-brand"
              >
                <option value="">全部类别</option>
                {categoryOptions.map((value) => (
                  <option key={value} value={value}>
                    {CATEGORY_LABELS[value] ? `${value} · ${CATEGORY_LABELS[value]}` : value}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-3">
              级别
              <select
                value={level}
                onChange={(event) => setLevel(event.target.value)}
                className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none transition focus:border-brand"
              >
                <option value="">全部级别</option>
                <option value="error">错误</option>
                <option value="warn">警告</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-3">
              时间
              <select
                value={days}
                onChange={(event) => setDays(event.target.value)}
                className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-xs text-ink outline-none transition focus:border-brand"
              >
                <option value="1">最近 1 天</option>
                <option value="3">最近 3 天</option>
                <option value="7">最近 7 天</option>
              </select>
            </label>
            <span className="text-[11px] text-ink-3 sm:ml-auto">
              每次 200 条（新→旧）{health ? ` · ${health.fileCount} 个文件 / ${formatBytes(health.totalBytes)}` : ""}
            </span>
          </div>

          {error && (
            <div className="flex items-start gap-3 border-b border-red-100 bg-red-50/70 px-5 py-3 text-sm text-red-800 sm:px-6">
              <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          {health && !health.ok && (
            <div className="flex items-start gap-3 border-b border-red-100 bg-red-50/70 px-5 py-3 text-sm text-red-800 sm:px-6">
              <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
              <span>
                问题日志目录当前不可写，结构化记录可能缺失；journal 仍保留 `[anppt-v2][problem]` 兜底行。请先检查磁盘、目录权限和 `ANPPT_V2_PROBLEM_LOG_DIR`。
              </span>
            </div>
          )}

          {health && health.ok && health.recentFailure && health.writeFailures > 0 && (
            <div className="flex items-start gap-3 border-b border-amber-100 bg-amber-50/70 px-5 py-3 text-sm text-amber-800 sm:px-6">
              <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
              本次进程启动以来记录到 {health.writeFailures} 次日志写入失败，最近一次 {health.lastFailureAt ? formatTime(health.lastFailureAt) : "—"}。若无新增失败可先观察。
            </div>
          )}

          {items.length === 0 ? (
            <div className="px-5 py-16 text-center sm:px-6">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-soft text-brand">
                <AlertIcon width={20} height={20} />
              </span>
              <p className="mt-3 text-sm font-medium text-ink-2">
                {loading ? "正在读取问题日志…" : error ? "问题日志暂时不可读" : "该时间范围内没有匹配的问题记录"}
              </p>
              <p className="mt-1 text-xs text-ink-3">
                站点失败会实时写入服务器 logs/problems-YYYY-MM-DD[.N].jsonl；若近期主链路平稳，这里为空属正常。
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-line bg-page/60 text-[11px] uppercase tracking-wide text-ink-3">
                    <th className="px-4 py-2.5 font-medium">时间</th>
                    <th className="px-4 py-2.5 font-medium">级别</th>
                    <th className="px-4 py-2.5 font-medium">类别</th>
                    <th className="px-4 py-2.5 font-medium">消息</th>
                    <th className="px-4 py-2.5 font-medium">用户</th>
                    <th className="px-4 py-2.5 font-medium">引用</th>
                    <th className="px-4 py-2.5 font-medium">追踪</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {items.map((item, index) => (
                    <tr key={`${item.eventId || item.ts}-${index}`} className="align-top">
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-3">{formatTime(item.ts)}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${item.level === "warn" ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700"}`}>
                          {LEVEL_LABEL[item.level] || item.level}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded-md bg-page px-2 py-0.5 font-mono text-[11px] text-ink-2">{item.category}</span>
                      </td>
                      <td className="max-w-[360px] px-4 py-3">
                        <p className="text-[13px] leading-5 text-ink">{item.message}</p>
                        {item.detail && (
                          <p className="mt-1 line-clamp-2 break-all font-mono text-[11px] leading-4 text-ink-3" title={item.detail}>
                            {item.detail}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-ink-3">
                        {item.userId ? item.userId.slice(0, 8) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-ink-3">
                        {item.refType || item.refId ? `${item.refType}:${item.refId}` : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] leading-4 text-ink-3">
                        <div title={item.requestId || "旧记录无请求号"}>{item.requestId ? item.requestId.slice(0, 16) : "—"}</div>
                        <div className="mt-1 text-[10px] text-ink-4" title={item.release || "旧记录无发布版本"}>
                          {item.release ? item.release.slice(0, 12) : "—"}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {hasMore && (
            <div className="border-t border-line px-5 py-4 text-center sm:px-6">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void load(nextOffset, true)}
                className="rounded-xl border border-line bg-white px-4 py-2 text-sm font-medium text-ink-2 transition hover:text-ink disabled:opacity-60"
              >
                {loadingMore ? "加载中…" : `加载更多（还有 ${Math.max(total - items.length, 0)} 条）`}
              </button>
            </div>
          )}
        </section>

        <p className="mt-3 text-[11px] leading-5 text-ink-3">
          文件位置：&lt;数据目录&gt;/logs/problems-YYYY-MM-DD[.N].jsonl（目录可用 ANPPT_V2_PROBLEM_LOG_DIR 覆盖）；保留 14 天，单文件 20 MiB 滚动，总量超过 100 MiB 时优先删最旧文件；当天仍超限则拒绝新落盘并告警。
        </p>
      </div>
    </div>
  );
}
