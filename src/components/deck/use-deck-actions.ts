"use client";

// deck 动作执行器的 React 外壳：只把执行器的在飞集合镜像成渲染态（判重仍由执行器同步完成）。
// 余额刷新统一走这里，组件不再各自调 notifyCreditsRefresh。
import { useCallback, useMemo, useState } from "react";
import { deckIntentAction, type DeckState } from "@/lib/client/deck-api";
import {
  createDeckActionRunner,
  isDeckActionBusy,
  type DeckActionRun,
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
  const { deckId, onState, onInsufficientCredits, toast } = input;
  const [keys, setKeys] = useState<readonly string[]>([]);

  const runner = useMemo(
    () =>
      createDeckActionRunner({
        deckId,
        dispatch: <K extends DeckIntentKind>(intent: Extract<DeckIntent, { kind: K }>) =>
          deckIntentAction(deckId, intent),
        onState,
        onCreditsChanged: notifyCreditsRefresh,
        onInsufficientCredits,
        toast,
        onBusyChange: setKeys,
      }),
    [deckId, onState, onInsufficientCredits, toast],
  );

  const busy = useCallback<DeckActionBusy>(
    (kind, entityId = deckId) => isDeckActionBusy(keys, kind, entityId),
    [keys, deckId],
  );

  return { run: runner.run, busy };
}
