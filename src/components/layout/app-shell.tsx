"use client";

import Image from "next/image";
import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, MenuIcon } from "@/components/icons";
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

export function AppShell({
  announcement,
  serviceEmail,
  tutorialUrl,
  footer,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-screen">
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
          className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-card transition-[width] duration-200 lg:flex ${
            collapsed ? "w-16" : "w-[216px]"
          }`}
        >
          <div className="relative">
            <SidebarBrand collapsed={collapsed} />
            <button
              type="button"
              aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
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
          <div className="min-h-0 flex-1">
            <SidebarNav
              collapsed={collapsed}
              serviceEmail={serviceEmail}
              tutorialUrl={tutorialUrl}
            />
          </div>
        </aside>

        {/* 移动端抽屉 */}
        {drawerOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div
              className="absolute inset-0 bg-ink/40"
              onClick={() => setDrawerOpen(false)}
            />
            <div className="absolute left-0 top-0 flex h-full w-64 flex-col bg-card shadow-pop">
              <SidebarBrand collapsed={false} />
              <div className="min-h-0 flex-1">
                <SidebarNav
                  collapsed={false}
                  serviceEmail={serviceEmail}
                  tutorialUrl={tutorialUrl}
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
              <UserArea />
            </div>
          </header>

          <main className="flex-1">{children}</main>

          {footer}
        </div>
      </div>
    </div>
  );
}
