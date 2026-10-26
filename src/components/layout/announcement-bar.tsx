"use client";

import { useEffect, useState } from "react";
import { CloseIcon } from "@/components/icons";

interface Props {
  html: string;
  backgroundColor: string;
  textColor: string;
  revision: number;
}

export function AnnouncementBar({
  html,
  backgroundColor,
  textColor,
  revision,
}: Props) {
  const storageKey = `anppt-announcement-dismissed:${revision}`;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setVisible(localStorage.getItem(storageKey) !== "1");
      } catch {
        setVisible(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [storageKey]);

  if (!visible) return null;

  return (
    <div
      className="relative z-40 flex items-center justify-center gap-3 px-10 py-2 text-center text-[13px] leading-5"
      style={{ backgroundColor, color: textColor }}
    >
      {/* 公告 HTML 来自本站配置模块（src/data/site-config.ts），非用户输入 */}
      <span dangerouslySetInnerHTML={{ __html: html }} />
      <button
        type="button"
        aria-label="关闭公告"
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 opacity-80 transition hover:opacity-100"
        onClick={() => {
          setVisible(false);
          try {
            localStorage.setItem(storageKey, "1");
          } catch {
            /* ignore */
          }
        }}
      >
        <CloseIcon width={14} height={14} />
      </button>
    </div>
  );
}
