"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon, StarIcon } from "@/components/icons";
import type { ShellSessionUser } from "@/components/layout/app-shell";
import { api } from "@/lib/client/api";

/**
 * 顶部右侧用户区：积分 pill + 购买与兑换 + 登录/用户菜单。
 * 未登录或后端未就绪时显示「积分 --」与登录按钮。
 * 用户菜单里放登出入口：`api.auth.logout()` 只能从这里触发，删掉它会留下一个没人调用的接口。
 */
export function UserArea({
  user,
  sessionReady,
}: {
  user: ShellSessionUser | null;
  sessionReady: boolean;
}) {
  const [balance, setBalance] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
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

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLogoutError(null);
    setLoggingOut(true);
    try {
      await api.auth.logout();
      // AppShell 只在挂载时拉取 session，硬跳转让顶栏与各页面客户端状态一起复位；
      // replace 让登出后的后退不会回到已失效的受保护页面。
      window.location.replace("/");
    } catch {
      setLogoutError("退出失败，请重试");
      setLoggingOut(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex shrink-0 items-center overflow-hidden whitespace-nowrap rounded-full border border-brand-line bg-brand-softer text-[13px]">
        <span className="flex items-center gap-1 px-3 py-1.5 text-ink-2">
          <StarIcon width={13} height={13} className="text-brand" />
          积分 {balance === null ? "--" : balance}
        </span>
        <Link
          href="/recharge"
          className="hidden border-l border-brand-line px-3 py-1.5 font-medium text-brand transition hover:bg-brand-soft sm:flex"
        >
          购买与兑换
        </Link>
      </div>
      {userName ? (
        <div ref={menuRef} className="relative min-w-0">
          <div className="flex h-9 min-w-0 items-center rounded-full bg-dark text-[13px] font-medium text-white">
            {user?.role === "admin" && (
              <Link
                href="/admin"
                className="ml-1 rounded-full bg-brand px-2 py-1 text-[10px] font-semibold tracking-wide text-white transition hover:bg-brand-strong"
              >
                管理员
              </Link>
            )}
            <button
              ref={triggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((open) => !open)}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-full px-3 transition hover:bg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="min-w-0 max-w-20 truncate sm:max-w-40">{userName}</span>
              <ChevronDownIcon
                width={14}
                height={14}
                className={`text-white/70 transition-transform ${menuOpen ? "rotate-180" : ""}`}
              />
            </button>
          </div>
          {menuOpen && (
            <div
              id={menuId}
              role="menu"
              className="absolute right-0 top-full z-50 mt-2 w-40 overflow-hidden rounded-xl border border-line bg-card py-1 text-[13px] text-ink shadow-pop"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                className="flex w-full items-center px-3 py-2 text-left transition hover:bg-brand-softer disabled:cursor-wait disabled:text-ink-3"
              >
                {loggingOut ? "正在退出…" : "退出登录"}
              </button>
              {logoutError && (
                <p role="alert" className="px-3 pb-1 text-xs text-danger">
                  {logoutError}
                </p>
              )}
            </div>
          )}
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
