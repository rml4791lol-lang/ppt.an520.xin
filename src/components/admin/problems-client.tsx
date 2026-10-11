"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertIcon, ChevronLeftIcon, RefreshIcon } from "@/components/icons";

interface ProblemItem {
  ts: number;
  level: "error" | "warn";
  category: string;
  message: string;
  detail: string;
  userId: string;
  refType: string;
  refId: string;
}

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "全部类别" },
  { value: "api", label: "api · 接口异常" },
  { value: "generation", label: "generation · 生成/退款" },
  { value: "image-upstream", label: "image-upstream · 生图上游" },
  { value: "editable", label: "editable · 可编辑导出" },
  { value: "ppt-to-base", label: "ppt-to-base · 模版底座" },
  { value: "payments", label: "payments · 支付回调" },
  { value: "otp", label: "otp · 验证码" },
  { value: "sms", label: "sms · 短信" },
];

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

async function fetchProblems(query: string): Promise<ProblemItem[]> {
  const response = await fetch(`/api/admin/problems?${query}`, { cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as ApiEnvelope<{ items: ProblemItem[] }> | null;
  if (!response.ok || !payload?.ok || !payload.data) {
    throw new Error(payload?.error?.message || "问题日志加载失败");
  }
  return payload.data.items;
}

export function ProblemsClient({ admin }: { admin: { displayName: string } }) {
  const [days, setDays] = useState("3");
  const [category, setCategory] = useState("");
  const [level, setLevel] = useState("");
  const [items, setItems] = useState<ProblemItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ days, limit: "200" });
    if (category) params.set("category", category);
    if (level) params.set("level", level);
    try {
      setItems(await fetchProblems(params.toString()));
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "问题日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [category, days, level]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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
                站点关键失败的结构化记录（接口异常、生成退款、上游失败、支付回调、验证码交付等）。落盘失败不影响业务，日志按天分文件、保留 14 天。
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-ink-3">
                <span className="rounded-full border border-line bg-white px-2.5 py-1">管理员：{admin.displayName}</span>
                <span className="rounded-full border border-line bg-white px-2.5 py-1">共 {items.length} 条</span>
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
                onClick={() => void load()}
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
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
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
            <span className="text-[11px] text-ink-3 sm:ml-auto">最多展示 200 条（新→旧）</span>
          </div>

          {error && (
            <div className="flex items-start gap-3 border-b border-red-100 bg-red-50/70 px-5 py-3 text-sm text-red-800 sm:px-6">
              <AlertIcon width={16} height={16} className="mt-0.5 shrink-0" />
              {error}
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
                站点失败会实时写入服务器 logs/problems-YYYY-MM-DD.jsonl；若近期主链路平稳，这里为空属正常。
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[880px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-line bg-page/60 text-[11px] uppercase tracking-wide text-ink-3">
                    <th className="px-4 py-2.5 font-medium">时间</th>
                    <th className="px-4 py-2.5 font-medium">级别</th>
                    <th className="px-4 py-2.5 font-medium">类别</th>
                    <th className="px-4 py-2.5 font-medium">消息</th>
                    <th className="px-4 py-2.5 font-medium">用户</th>
                    <th className="px-4 py-2.5 font-medium">引用</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {items.map((item, index) => (
                    <tr key={`${item.ts}-${index}`} className="align-top">
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="mt-3 text-[11px] leading-5 text-ink-3">
          文件位置：&lt;数据目录&gt;/logs/problems-YYYY-MM-DD.jsonl（目录可用 ANPPT_V2_PROBLEM_LOG_DIR 覆盖）；写入时自动清理早于 14 天的文件。
        </p>
      </div>
    </div>
  );
}
