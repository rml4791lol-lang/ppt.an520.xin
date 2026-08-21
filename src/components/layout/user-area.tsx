"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StarIcon } from "@/components/icons";

interface SessionResponse {
  ok: boolean;
  data?: {
    authenticated?: boolean;
    user: { name?: string; nickname?: string; displayName?: string; username?: string; avatarUrl?: string | null } | null;
  };
}

interface BalanceResponse {
  ok: boolean;
  data?: { balance?: number; available?: number };
}

/**
 * 顶部右侧用户区：积分 pill + 购买与兑换 + 登录/用户。
 * 未登录或后端未就绪时显示「积分 --」与登录按钮。
 */
export function UserArea() {
  const [userName, setUserName] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const sessionRes = await fetch("/api/auth/session", { cache: "no-store" });
        if (!sessionRes.ok) return;
        const session = (await sessionRes.json()) as SessionResponse;
        const user = session.ok && session.data?.authenticated ? session.data.user : null;
        if (cancelled || !user) return;
        setUserName(user.displayName ?? user.nickname ?? user.name ?? user.username ?? "已登录用户");
        const balRes = await fetch("/api/credits/balance", { cache: "no-store" });
        if (!balRes.ok) return;
        const bal = (await balRes.json()) as BalanceResponse;
        const value = bal.data?.balance ?? bal.data?.available;
        if (!cancelled && typeof value === "number") setBalance(value);
      } catch {
        /* 后端未就绪时保持占位态 */
      }
    };
    const initialTimer = window.setTimeout(() => {
      void load();
    }, 0);
    // 充值到账 / 生成扣费后由业务侧派发该事件刷新余额（与 deck 工作台同一约定）
    const onRefresh = () => void load();
    window.addEventListener("anppt:credits-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.removeEventListener("anppt:credits-refresh", onRefresh);
    };
  }, []);

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex items-center overflow-hidden rounded-full border border-brand-line bg-brand-softer text-[13px]">
        <span className="flex items-center gap-1 px-3 py-1.5 text-ink-2">
          <StarIcon width={13} height={13} className="text-brand" />
          积分 {balance === null ? "--" : balance}
        </span>
        <Link
          href="/recharge"
          className="border-l border-brand-line px-3 py-1.5 font-medium text-brand transition hover:bg-brand-soft"
        >
          购买与兑换
        </Link>
      </div>
      {userName ? (
        <span className="flex h-9 items-center rounded-full bg-dark px-4 text-[13px] font-medium text-white">
          {userName}
        </span>
      ) : (
        <Link
          href="/login"
          className="flex h-9 items-center rounded-full bg-dark px-4 text-[13px] font-medium text-white transition hover:bg-ink"
        >
          登录
        </Link>
      )}
    </div>
  );
}
