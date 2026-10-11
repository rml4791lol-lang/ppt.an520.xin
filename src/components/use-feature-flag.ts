"use client";

import { useEffect, useState } from "react";
import { getFeatureFlags } from "@/lib/client/deck-api";

/** 开关板可见性；加载失败当不可见，避免普通用户闪出入口。 */
export function useFeatureFlag(key: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getFeatureFlags()
      .then(({ flags }) => {
        if (!cancelled) setOn(Boolean(flags[key]));
      })
      .catch(() => {
        if (!cancelled) setOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return on;
}
