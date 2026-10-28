"use client";

// 单页动作执行器的 React 外壳：只把在飞集合镜像成渲染态（判重与互斥仍由执行器同步完成）。
// 执行器实例只在首次动作时创建并保持稳定（dispatch/提示/页面判活经 latest-ref 读取）：
// 每次渲染重建会把执行器内部的在飞集合丢掉，双击就能穿透判重。
import { useEffect, useRef, useState } from "react";
import {
  createSinglePageActionRunner,
  isSinglePageActionBusy,
  type SinglePageAction,
  type SinglePageActionKind,
  type SinglePageActionOutcome,
  type SinglePageInflight,
  type SinglePageRun,
} from "@/lib/client/single-page-actions";

/** 该动作对该页是否在飞（含互斥动作与「本页仍在生成」） */
export interface SinglePageActionBusy {
  (kind: SinglePageActionKind, pageId: string): boolean;
}

export function useSinglePageActions(input: {
  dispatch: (action: SinglePageAction) => Promise<SinglePageActionOutcome>;
  onUnauthorized: () => void;
  onInsufficientCredits: (message: string) => void;
  toast: (text: string) => void;
  isPageRunning: (pageId: string) => boolean;
}): { run: SinglePageRun; busy: SinglePageActionBusy; inflight: readonly SinglePageInflight[] } {
  const [inflight, setInflight] = useState<readonly SinglePageInflight[]>([]);
  const latest = useRef(input);
  const runner = useRef<ReturnType<typeof createSinglePageActionRunner> | null>(null);

  useEffect(() => {
    latest.current = input;
  });

  const getRunner = () => {
    if (!runner.current) {
      runner.current = createSinglePageActionRunner({
        dispatch: (action) => latest.current.dispatch(action),
        onUnauthorized: () => latest.current.onUnauthorized(),
        onInsufficientCredits: (message) => latest.current.onInsufficientCredits(message),
        toast: (text) => latest.current.toast(text),
        isPageRunning: (pageId) => latest.current.isPageRunning(pageId),
        onBusyChange: setInflight,
      });
    }
    return runner.current;
  };

  const run: SinglePageRun = (action, opts) => getRunner().run(action, opts);

  const busy: SinglePageActionBusy = (kind, pageId) =>
    isSinglePageActionBusy(inflight, kind, pageId, input.isPageRunning(pageId));

  return { run, busy, inflight };
}
