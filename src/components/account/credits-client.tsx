"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Summary {
  balance?: number;
  totalGranted?: number;
  totalSpent?: number;
  granted30d?: number;
  spent30d?: number;
}

interface LedgerEntry {
  delta: number;
  balanceAfter?: number;
  reason?: string;
  eventType?: string;
  createdAt?: number | string;
}

function AuthWall({ onReload }: { onReload: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-danger/20 bg-danger-soft px-5 py-4">
      <p className="text-sm text-danger">请先登录后再操作</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onReload}
          className="text-sm font-medium text-danger hover:underline"
        >
          重新加载
        </button>
        <Link
          href="/login?next=%2Faccount%2Fcredits"
          className="rounded-full bg-dark px-4 py-1.5 text-xs font-medium text-white"
        >
          去登录
        </Link>
      </div>
    </div>
  );
}

const CARDS: { key: keyof Summary; label: string; hint: string }[] = [
  { key: "balance", label: "可用星星", hint: "可用于生成和导出" },
  { key: "totalGranted", label: "累计获得", hint: "注册赠送、充值与兑换" },
  { key: "totalSpent", label: "累计已使用", hint: "生成消耗，失败自动退回" },
  { key: "spent30d", label: "近 30 天已用", hint: "最近 30 天的生成消耗" },
];

export function CreditsClient() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setUnauthorized(false);
    try {
      const [sumRes, ledgerRes] = await Promise.all([
        fetch("/api/credits/summary", { cache: "no-store" }),
        fetch("/api/credits/ledger", { cache: "no-store" }),
      ]);
      if (sumRes.status === 401 || ledgerRes.status === 401) {
        setUnauthorized(true);
        setSummary(null);
        setLedger(null);
        return;
      }
      if (sumRes.ok) {
        const json = await sumRes.json().catch(() => null);
        if (json?.ok) setSummary(json.data ?? {});
      }
      if (ledgerRes.ok) {
        const json = await ledgerRes.json().catch(() => null);
        if (json?.ok) {
          const list = json.data?.items ?? json.data?.entries ?? json.data?.records;
          if (Array.isArray(list)) setLedger(list);
        }
      }
    } catch {
      /* 后端未就绪时保持占位 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="space-y-6">
      {unauthorized && <AuthWall onReload={() => void load()} />}

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {CARDS.map((card) => (
          <div
            key={card.key}
            className="rounded-2xl border border-line bg-card p-5 shadow-card"
          >
            <p className="text-sm text-ink-3">{card.label}</p>
            <p className="mt-2 text-2xl font-bold tracking-tight text-ink">
              {summary?.[card.key] ?? "—"}
            </p>
            <p className="mt-2 text-xs text-ink-4">{card.hint}</p>
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-line bg-card shadow-card">
        <div className="border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold text-ink">星星记录</h2>
        </div>
        {loading ? (
          <p className="px-5 py-12 text-center text-sm text-ink-3">加载中…</p>
        ) : unauthorized ? (
          <p className="px-5 py-12 text-center text-sm text-ink-3">
            登录后可查看星星收支明细
          </p>
        ) : ledger && ledger.length > 0 ? (
          <ul className="divide-y divide-line">
            {ledger.map((entry, index) => (
              <li
                key={`${entry.createdAt ?? "row"}-${index}`}
                className="flex items-center justify-between px-5 py-3.5"
              >
                <div>
                  <p className="text-sm text-ink">
                    {entry.reason ?? "星星变动"}
                  </p>
                  {entry.createdAt && (
                    <p className="mt-0.5 text-xs text-ink-4">
                      {new Date(entry.createdAt).toLocaleString("zh-CN")}
                    </p>
                  )}
                </div>
                <span
                  className={`text-sm font-semibold ${
                    entry.delta >= 0 ? "text-emerald-600" : "text-ink"
                  }`}
                >
                  {entry.delta >= 0 ? "+" : ""}
                  {entry.delta} 🌟
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-5 py-12 text-center text-sm text-ink-3">
            暂无星星记录
          </p>
        )}
      </div>
    </div>
  );
}
