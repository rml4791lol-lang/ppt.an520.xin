// 工作台可用性唯一推导：哪些按钮能点由 deck 状态算出，避免各步组件散落布尔条件。
// 只做派生（不发请求、不持有 UI 态）：saving/editor/弹窗这类局部状态仍留在组件内。
import type { DeckState } from "./deck-api";

export interface DeckAvailability {
  /** 整套生成在跑（状态或活动任务）：期间禁止再发起生成、改内容 */
  generating: boolean;
  /** 内容可改（未冻结） */
  contentEditable: boolean;
  /** 尚未梳理完成的页数 */
  pendingStructure: number;
  /** 全部页梳理完成且至少一页 */
  structureReady: boolean;
  /** 尚未生成成功的页数 */
  pendingGeneration: number;
  /** 内容已冻结 → 可发起整套生成（风格是否已选由 UI 另行校验） */
  canGenerate: boolean;
  /** 已有生成结果（generated / partial） */
  hasGenerated: boolean;
  /** 整套都生成成功 */
  allGenerated: boolean;
  /** 有成功页 → 可导出图片集 */
  canExport: boolean;
  /** 有失败页且当前无生成任务 → 可一键重试 */
  canRetryFailed: boolean;
}

export function deriveDeckAvailability(state: DeckState): DeckAvailability {
  const generating = state.deck.status === "generating" || state.activeJob !== null;
  const pendingStructure = state.slides.filter((s) => s.structureStatus !== "ok").length;
  const pendingGeneration = state.slides.filter((s) => s.genStatus !== "succeeded").length;
  return {
    generating,
    contentEditable: !state.contentLocked,
    pendingStructure,
    structureReady: state.slides.length > 0 && pendingStructure === 0,
    pendingGeneration,
    canGenerate: state.contentLocked,
    hasGenerated: state.deck.status === "generated" || state.deck.status === "partial",
    allGenerated: state.deck.status === "generated",
    canExport: state.pageSummary.succeeded > 0,
    canRetryFailed: state.pageSummary.failed > 0 && !generating,
  };
}
