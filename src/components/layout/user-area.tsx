"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StarIcon } from "@/components/icons";
import type { ShellSessionUser } from "@/components/layout/app-shell";
import { api } from "@/lib/client/api";

/**
 * 顶部右侧用户区：积分 pill + 购买与兑换 + 登录/用户。
 * 未登录或后端未就绪时显示「积分 --」与登录按钮。
 */
export function UserArea({
  user,
  sessionReady,
}: {
  user: ShellSessionUser | null;
  sessionReady: boolean;
}) {
  const [balance, setBalance] = useState<number | null>(null);
  const userName = user?.displayName ?? user?.username ?? user?.email ?? null;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!user) {
        setBalance(null);
        return;
      }
      try {
        const value = await api.credits.balance();
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
  }, [user]);

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
        <div className="flex h-9 items-center overflow-hidden rounded-full bg-dark text-[13px] font-medium text-white">
          {user?.role === "admin" && (
            <Link
              href="/admin"
              className="ml-1 rounded-full bg-brand px-2 py-1 text-[10px] font-semibold tracking-wide text-white transition hover:bg-brand-strong"
            >
              管理员
            </Link>
          )}
          <span className="max-w-28 truncate px-3 sm:max-w-40">{userName}</span>
        </div>
      ) : (
        sessionReady && (
          <Link
            href="/login"
            className="flex h-9 items-center rounded-full bg-dark px-4 text-[13px] font-medium text-white transition hover:bg-ink"
          >
            登录
          </Link>
        )
      )}
    </div>
  );
}
