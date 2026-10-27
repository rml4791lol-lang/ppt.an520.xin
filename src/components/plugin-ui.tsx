"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { MonitorIcon, SparklesIcon } from "@/components/icons";
import { getFeatureFlags } from "@/lib/client/deck-api";
import type { UiComponentLoader, UiSlot } from "@/lib/plugin/types";
import { entriesForSlot, type SlotEntry } from "@/plugins/ui-registry";

type ShellIcon = React.ComponentType<{ width?: number; height?: number }>;

const ICONS: Record<string, ShellIcon> = { monitor: MonitorIcon };

/** 插件只声明图标名，组件留在壳的设计系统里（插件不自带风格）。 */
export function pluginIcon(name?: string): ShellIcon {
  return (name ? ICONS[name] : undefined) ?? SparklesIcon;
}

// 懒加载组件在模块作用域一次性建好，渲染时只做查表（不影响首屏 bundle）。
const PANELS = new Map<string, React.ComponentType>();
for (const slot of ["upload-card", "template-library"] as const) {
  for (const entry of entriesForSlot(slot)) {
    PANELS.set(
      `${entry.slot}:${entry.id}`,
      dynamic(entry.component, {
        ssr: false,
        loading: () => <p className="py-10 text-center text-sm text-ink-3">正在加载…</p>,
      }),
    );
  }
}

/** 某挂载点的可见入口：开关未加载前按不可见处理，避免普通用户闪出入口。 */
export function usePluginEntries<S extends UiSlot>(slot: S): SlotEntry<S>[] {
  const [flags, setFlags] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFeatureFlags()
      .then(({ flags: next }) => {
        if (!cancelled) setFlags(next);
      })
      .catch(() => {
        if (!cancelled) setFlags({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(
    () => entriesForSlot(slot).filter((entry) => !entry.flag || flags?.[entry.flag] === true),
    [slot, flags],
  );
}

function panelKey(entry: { slot: UiSlot; id: string }): string {
  return `${entry.slot}:${entry.id}`;
}

/** 组件经 props 传入再渲染：入口查表不改变组件身份（react-hooks/static-components）。 */
function PanelOutlet({ component: Component }: { component: React.ComponentType }) {
  return <Component />;
}

/** 槽位面板：组件按 entry 的懒加载指令动态导入，插件 JS 不进首屏。 */
export function PluginSlotPanel({
  entry,
}: {
  entry: { slot: UiSlot; id: string; component: UiComponentLoader };
}) {
  const Panel = PANELS.get(panelKey(entry));
  return Panel ? <PanelOutlet component={Panel} /> : null;
}
