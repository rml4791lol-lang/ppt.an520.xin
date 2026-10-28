"use client";

// deck 动作执行器的 React 外壳：只把执行器的在飞集合镜像成渲染态（判重仍由执行器同步完成）。
// 执行器实例按 deckId 保持稳定（回调经 latest-ref 读取）：每次渲染重建会把在飞集合丢掉，
// 双击就能穿透判重。余额刷新统一走这里，组件不再各自调 notifyCreditsRefresh。
import { useCallback, useEffect, useRef, useState } from "react";
import { deckIntentAction, type DeckState } from "@/lib/client/deck-api";
import {
  createDeckActionRunner,
  isDeckActionBusy,
  type DeckActionRun,
  type DeckActionRunner,
} from "@/lib/client/deck-actions";
import type { DeckIntent, DeckIntentKind } from "@/lib/deck-intents";
import { notifyCreditsRefresh } from "@/components/deck/use-deck-state";

/** 该动作对该实体是否在飞（缺省实体 = 整套） */
export interface DeckActionBusy {
  (kind: DeckIntentKind, entityId?: string): boolean;
}

export function useDeckActions(input: {
  deckId: string;
  onState: (state: DeckState) => void;
  onInsufficientCredits: (message: string) => void;
  toast: (text: string) => void;
}): { run: DeckActionRun; busy: DeckActionBusy } {
  const { deckId } = input;
  const [keys, setKeys] = useState<readonly string[]>([]);
  const latest = useRef(input);
  const runner = useRef<{ deckId: string; runner: DeckActionRunner } | null>(null);

  useEffect(() => {
    latest.current = input;
  });

  const getRunner = useCallback(() => {
    if (!runner.current || runner.current.deckId !== latest.current.deckId) {
      const runDeckId = latest.current.deckId;
      runner.current = {
        deckId: runDeckId,
        runner: createDeckActionRunner({
          deckId: runDeckId,
          dispatch: <K extends DeckIntentKind>(intent: Extract<DeckIntent, { kind: K }>) =>
            deckIntentAction(latest.current.deckId, intent),
          onState: (state) => latest.current.onState(state),
          onCreditsChanged: notifyCreditsRefresh,
          onInsufficientCredits: (message) => latest.current.onInsufficientCredits(message),
          toast: (text) => latest.current.toast(text),
          onBusyChange: setKeys,
        }),
      };
    }
    return runner.current.runner;
  }, []);

  const run = useCallback<DeckActionRun>(
    (intent, opts) => getRunner().run(intent, opts),
    [getRunner],
  );

  const busy = useCallback<DeckActionBusy>(
    (kind, entityId = deckId) => isDeckActionBusy(keys, kind, entityId),
    [keys, deckId],
  );

  return { run, busy };
}
