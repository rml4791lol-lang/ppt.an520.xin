// 复刻模块唯一的对外服务端入口：项目 / 页 / 版本三个实体，以及它们与计费、懒恢复的关系。
// 实现暂时逐项委托平台单页运行时（扣费/退款/版本/恢复全平台只有一份，不能在本模块另造）；
// 后续把实体搬进本目录时只改这里，路由与平台调用面不动。
import { estimateCredits } from '@/lib/server/credits';
import { reconcileUser } from '@/lib/server/generation/recovery';
import {
  getOwnedPage,
  getSingleProjectDetail,
  listPageVersions,
  listSingleProjectPageStatuses,
  listSingleProjectPages,
  saveReplicateDraft as saveReplicateDraftOnPlatform,
  selectSinglePageVersion,
  type SinglePageRow,
  type SinglePageStatusView,
  type SinglePageVersionView,
} from '@/lib/server/generation/single-pages';

export type { SinglePageRow, SinglePageStatusView, SinglePageVersionView };

// 复刻分支持有的提示词契约也收在这里：平台复刻分支只认本入口，不直接摸模块内部文件。
export {
  buildReplicateCopyPrompt,
  buildReplicateInstruction,
  parseIncomingStructure,
  resolveReplicateColorMode,
} from './replicate';
export type { ReplicateColorMode, SlideStructureCard } from './replicate';

export type ReplicateDraftInput = Parameters<typeof saveReplicateDraftOnPlatform>[1];

/** 创建/更新复刻项目并写入页（文案 + 壳图）：不生成、不扣星。 */
export function saveReplicateDraft(
  userId: string,
  input: ReplicateDraftInput,
): ReturnType<typeof saveReplicateDraftOnPlatform> {
  return saveReplicateDraftOnPlatform(userId, input);
}

export type ReplicateProjectDetail = ReturnType<typeof getSingleProjectDetail>;

/** 项目查询：元信息 + 页 + 每页版本；读取时懒恢复中断页。 */
export function getReplicateProject(userId: string, projectId: string): ReplicateProjectDetail {
  return getSingleProjectDetail(userId, projectId);
}

export function getReplicatePage(userId: string, pageId: string): SinglePageRow {
  return getOwnedPage(userId, pageId);
}

export function listReplicatePages(userId: string, projectId: string): SinglePageRow[] {
  return listSingleProjectPages(userId, projectId);
}

export function listReplicatePageStatuses(userId: string, projectId: string): SinglePageStatusView[] {
  return listSingleProjectPageStatuses(userId, projectId);
}

/** 版本表没有 user_id，对外入口先过页归属再查，避免被当成任意 pageId 的直查口。 */
export function listReplicatePageVersions(userId: string, pageId: string): SinglePageVersionView[] {
  getOwnedPage(userId, pageId);
  return listPageVersions(pageId);
}

export function selectReplicatePageVersion(userId: string, pageId: string, versionId: string): SinglePageRow {
  return selectSinglePageVersion(userId, pageId, versionId);
}

/** 模块计费动作声明：单价仍由平台 config/env 现读，模块里不存价格。 */
export const REPLICATE_BILLING_ACTIONS = {
  pageGenerate: 'single_page_generate',
  pageRefine: 'single_page_refine',
  editableExport: 'export_editable',
} as const;

export type ReplicateBillingAction = (typeof REPLICATE_BILLING_ACTIONS)[keyof typeof REPLICATE_BILLING_ACTIONS];

export function quoteReplicateCredits(action: ReplicateBillingAction, pages = 1) {
  return estimateCredits({ action, pages });
}

/** 收敛该用户全部中断任务；恢复只有平台一份入口（见 docs/DEBUG-HANDBOOK.md §4）。 */
export function reconcileReplicateUser(userId: string): boolean {
  return reconcileUser(userId) > 0;
}
