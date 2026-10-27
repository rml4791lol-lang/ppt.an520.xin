"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, MenuIcon } from "@/components/icons";
import { getSession } from "@/lib/client/api";
import { AnnouncementBar } from "@/components/layout/announcement-bar";
import { SidebarBrand, SidebarNav } from "@/components/layout/sidebar";
import { UserArea } from "@/components/layout/user-area";

interface AppShellProps {
  announcement: {
    enabled: boolean;
    html: string;
    backgroundColor: string;
    textColor: string;
    revision: number;
  };
  serviceEmail: string;
  tutorialUrl: string;
  footer: React.ReactNode;
  children: React.ReactNode;
}

export interface ShellSessionUser {
  id: string;
  username?: string;
  email?: string | null;
  displayName?: string;
  role?: string;
}

export function AppShell({
  announcement,
  serviceEmail,
  tutorialUrl,
  footer,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessionUser, setSessionUser] = useState<ShellSessionUser | null>(null);
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  useEffect(() => {
    let cancelled = false;
    const loadSession = async () => {
      try {
        const session = await getSession();
        if (!cancelled) setSessionUser(session.user);
      } catch {
        if (!cancelled) setSessionUser(null);
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    };
    void loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only z-[100] rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        跳到主要内容
      </a>
      {announcement.enabled && (
        <AnnouncementBar
          html={announcement.html}
          backgroundColor={announcement.backgroundColor}
          textColor={announcement.textColor}
          revision={announcement.revision}
        />
      )}

      <div className="flex">
        {/* 桌面侧边栏 */}
        <aside
          id="app-sidebar"
          className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-card transition-[width] duration-200 lg:flex ${
            collapsed ? "w-16" : "w-[216px]"
          }`}
        >
          <div className="relative">
            <SidebarBrand collapsed={collapsed} />
            <button
              type="button"
              aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
              aria-expanded={!collapsed}
              aria-controls="app-sidebar-nav"
              onClick={() => setCollapsed((v) => !v)}
              className="absolute -right-3 top-5 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-card text-ink-3 shadow-card transition hover:text-ink"
            >
              {collapsed ? (
                <ChevronRightIcon width={13} height={13} />
              ) : (
                <ChevronLeftIcon width={13} height={13} />
              )}
            </button>
          </div>
          <div id="app-sidebar-nav" className="min-h-0 flex-1">
            <SidebarNav
              collapsed={collapsed}
              serviceEmail={serviceEmail}
              tutorialUrl={tutorialUrl}
              isAdmin={sessionUser?.role === "admin"}
            />
          </div>
        </aside>

        {/* 移动端抽屉 */}
        {drawerOpen && (
          <div
            id="mobile-nav"
            className="fixed inset-0 z-50 lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="导航菜单"
          >
            <div
              className="absolute inset-0 bg-ink/40"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="absolute left-0 top-0 flex h-full w-64 flex-col bg-card shadow-pop">
              <div className="relative">
                <SidebarBrand collapsed={false} />
                <button
                  type="button"
                  aria-label="关闭菜单"
                  className="absolute right-3 top-4 rounded-full p-1.5 text-ink-3 transition hover:bg-page hover:text-ink"
                  onClick={() => setDrawerOpen(false)}
                >
                  <CloseIcon width={16} height={16} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <SidebarNav
                  collapsed={false}
                  serviceEmail={serviceEmail}
                  tutorialUrl={tutorialUrl}
                  isAdmin={sessionUser?.role === "admin"}
                  onNavigate={() => setDrawerOpen(false)}
                />
              </div>
            </div>
          </div>
        )}

        {/* 内容列 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 px-4 py-3 sm:px-6 lg:justify-end lg:px-10">
            <button
              type="button"
              aria-label="打开菜单"
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav"
              className="rounded-lg p-1.5 text-ink-2 hover:bg-card lg:hidden"
              onClick={() => setDrawerOpen(true)}
            >
              <MenuIcon width={20} height={20} />
            </button>
            <Image
              src="/brand/anppt-fish-logo.png"
              alt="AnPPT 品牌 Logo"
              width={611}
              height={414}
              className="h-7 w-auto lg:hidden"
            />
            <div className="ml-auto">
              <UserArea user={sessionUser} sessionReady={sessionReady} />
            </div>
          </header>

          <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
            {children}
          </main>

          {footer}
        </div>
      </div>
    </div>
  );
}
