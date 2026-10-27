// 复刻模块唯一的对外服务端入口：项目 / 页 / 版本、草稿写入与逐页生成，以及它们与计费、懒恢复的关系。
// 实体与提示词归本模块（见 ./pages）；扣费/退款/版本表/懒恢复复用平台单页运行时的唯一一份实现。
import { estimateCredits } from '@/lib/server/credits';
import { reconcileUser } from '@/lib/server/generation/recovery';
import {
  getOwnedPage,
  getSingleProjectDetail,
  listPageVersions,
  listSingleProjectPageStatuses,
  listSingleProjectPages,
  selectSinglePageVersion,
  type SinglePageRow,
  type SinglePageStatusView,
  type SinglePageVersionView,
} from '@/lib/server/generation/single-pages';

export type { SinglePageRow, SinglePageStatusView, SinglePageVersionView };

// 实体写口与生成入口在 ./pages；本文件只做对外收口，调用方不再摸模块内部文件。
export { generateReplicatePage, saveReplicateDraft } from './pages';
export type { ReplicateDraftInput, ReplicateGenerateInput } from './pages';
// 提示词契约也是模块对外的一部分（拆页计划、批量任务与测试共用一份），仍在 facade 收口。
export {
  buildReplicateCopyPrompt,
  buildReplicateInstruction,
  parseIncomingStructure,
  resolveReplicateColorMode,
} from './replicate';
export type { ReplicateColorMode, SlideStructureCard } from './replicate';

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

/** 模块计费动作声明：单价由平台 pricing 插件现读，模块里不存价格。 */
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
