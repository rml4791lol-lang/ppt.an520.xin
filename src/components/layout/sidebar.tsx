"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  BookIcon,
  CoinIcon,
  CloseIcon,
  DownloadIcon,
  FolderIcon,
  HeadsetIcon,
  HomeIcon,
  LayersIcon,
  ReceiptIcon,
  SparklesIcon,
  WandIcon,
} from "@/components/icons";

interface NavItem {
  key: string;
  label: string;
  href?: string;
  icon: React.ComponentType<{ width?: number; height?: number }>;
  disabled?: boolean;
  badge?: string;
  onClick?: () => void;
}

function isActive(pathname: string, hash: string, href?: string) {
  if (!href) return false;
  const [path, frag] = href.split("#");
  const pathMatch =
    path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(path + "/");
  if (!pathMatch) return false;
  if (frag) return hash === `#${frag}`;
  return true;
}

function useHash() {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    update();
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return hash;
}

export function SidebarNav({
  collapsed,
  serviceEmail,
  tutorialUrl,
  onNavigate,
}: {
  collapsed: boolean;
  serviceEmail: string;
  tutorialUrl: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const hash = useHash();
  const [serviceOpen, setServiceOpen] = useState(false);

  const groups: NavItem[][] = [
    [
      { key: "home", label: "首页", href: "/", icon: HomeIcon },
      { key: "styles", label: "设计风格", href: "/style-packs", icon: SparklesIcon },
      { key: "projects", label: "我的项目", href: "/projects", icon: FolderIcon },
      { key: "exports", label: "下载中心", href: "/exports", icon: DownloadIcon },
    ],
    [
      { key: "credits", label: "积分明细", href: "/account/credits", icon: ReceiptIcon },
      { key: "recharge", label: "购买与兑换", href: "/recharge", icon: CoinIcon },
      {
        key: "service",
        label: "联系客服",
        icon: HeadsetIcon,
        onClick: () => setServiceOpen(true),
      },
    ],
    [
      {
        key: "file2editable",
        label: "文件转可编辑 PPT",
        href: "/tools/editable-converter",
        icon: LayersIcon,
        badge: "新",
      },
      {
        key: "onlyoffice",
        label: "免费 PPT 编辑",
        href: "/tools/onlyoffice",
        icon: BookIcon,
        badge: "会员权益",
      },
      { key: "single-page", label: "创意页面生成器", href: "/single-page", icon: WandIcon },
    ],
  ];

  return (
    <div className="flex h-full flex-col">
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {groups.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "mt-3 border-t border-line pt-3" : ""}>
            {group.map((item) => {
              const active = isActive(pathname, hash, item.href);
              const cls = [
                "group flex items-center gap-2 rounded-xl px-2.5 py-2 text-[14px] transition",
                active
                  ? "bg-brand-soft font-medium text-brand"
                  : item.disabled
                    ? "cursor-not-allowed text-ink-4"
                    : "text-ink-2 hover:bg-page hover:text-ink",
                collapsed ? "justify-center px-0" : "",
              ].join(" ");
              const inner = (
                <>
                  <item.icon width={18} height={18} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                  {!collapsed && item.badge && (
                    <span className="ml-auto shrink-0 whitespace-nowrap rounded-full bg-brand-soft px-1 py-0.5 text-[10px] leading-none text-brand">
                      {item.badge}
                    </span>
                  )}
                </>
              );
              if (item.disabled) {
                return (
                  <div
                    key={item.key}
                    className={cls}
                    title={collapsed ? item.label : undefined}
                    aria-disabled
                  >
                    {inner}
                  </div>
                );
              }
              if (item.onClick) {
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`${cls} w-full`}
                    title={collapsed ? item.label : undefined}
                    onClick={item.onClick}
                  >
                    {inner}
                  </button>
                );
              }
              return (
                <Link
                  key={item.key}
                  href={item.href!}
                  className={cls}
                  title={collapsed ? item.label : undefined}
                  onClick={onNavigate}
                >
                  {inner}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="border-t border-line px-3 py-3">
        {tutorialUrl ? (
          <a
            href={tutorialUrl}
            target="_blank"
            rel="noreferrer"
            className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-[14px] text-ink-2 transition hover:bg-page hover:text-ink ${
              collapsed ? "justify-center px-0" : ""
            }`}
            title={collapsed ? "使用指南" : undefined}
          >
            <BookIcon width={18} height={18} />
            {!collapsed && <span>使用指南</span>}
          </a>
        ) : (
          <div
            className={`flex cursor-not-allowed items-center gap-2.5 rounded-xl px-3 py-2 text-[14px] text-ink-4 ${
              collapsed ? "justify-center px-0" : ""
            }`}
            title="使用指南整理中"
          >
            <BookIcon width={18} height={18} />
            {!collapsed && <span>使用指南</span>}
          </div>
        )}
      </div>

      {serviceOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setServiceOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <h3 className="text-base font-semibold text-ink">联系客服</h3>
              <button
                type="button"
                aria-label="关闭"
                className="rounded-full p-1 text-ink-3 hover:bg-page"
                onClick={() => setServiceOpen(false)}
              >
                <CloseIcon width={16} height={16} />
              </button>
            </div>
            <p className="mt-3 text-sm leading-6 text-ink-2">
              遇到问题或有合作咨询，欢迎邮件联系我们，我们会在 1 个工作日内回复。
            </p>
            <a
              href={`mailto:${serviceEmail}`}
              className="mt-4 flex items-center justify-center rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-strong"
            >
              发邮件至 {serviceEmail}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export function SidebarBrand({ collapsed }: { collapsed: boolean }) {
  return (
    <Link
      href="/"
      className={`flex items-center gap-2.5 px-4 py-3.5 ${collapsed ? "justify-center px-0" : ""}`}
    >
      <Image
        src="/brand/anppt-fish-logo.png"
        alt="AnPPT 品牌 Logo"
        width={611}
        height={414}
        className="h-8 w-auto"
        priority
      />
      {!collapsed && (
        <span className="text-[17px] font-semibold tracking-tight text-ink">
          AnPPT
        </span>
      )}
    </Link>
  );
}
