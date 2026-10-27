// deck 动作 RPC 的类型化意图契约：客户端与路由共用一份，参数结构只在这里声明。
// 唯一请求形态是 {intent:{kind,params}}；旧 {action,...params} 入口已删除（取舍见 docs/DEBUG-HANDBOOK.md §29）。
import { acceptParams, type IntentParamsTable } from './intent-envelope';

export type SlideRole = 'cover' | 'toc' | 'section' | 'content' | 'ending';

/** update-slide 可写字段（对齐服务端 updateSlideContent 的 patch） */
export type DeckSlidePatch = {
  role?: SlideRole;
  chapter?: string;
  pageType?: string;
  title?: string;
  goal?: string;
  rawText?: string;
  summary?: string[];
  visualNote?: string;
  structuredContent?: string;
};

/** add-slide 的新页草稿（撤销删除要还原章节，草稿保留 chapter） */
export type DeckSlideDraft = Pick<
  DeckSlidePatch,
  'role' | 'chapter' | 'title' | 'goal' | 'rawText' | 'visualNote'
>;

/** 意图 → 参数；空对象表示该意图没有参数 */
export type DeckIntentParams = {
  generateOutline: { force?: boolean };
  addSlide: { atIndex?: number; slide?: DeckSlideDraft };
  removeSlide: { slideId: string };
  reorderSlides: { order: string[] };
  splitSlide: { slideId: string; into?: number };
  updateSlide: { slideId: string } & DeckSlidePatch;
  commitVersion: { slideId: string; versionId: string };
  structureSlides: { force?: boolean };
  structureSlide: { slideId: string };
  confirmStructure: Record<string, never>;
  unlockStructure: Record<string, never>;
  setStyle: { stylePackId: string };
  setReferenceImage: { slideId: string | null };
  generateSlides: { forceRegenerate?: boolean };
  retryFailedSlides: Record<string, never>;
  generateSlide: { slideId: string };
  refineSlide: { slideId: string; editInstruction: string };
  eraseSlide: { slideId: string; markImageDataUrl: string };
  editSlideText: { slideId: string; editInstruction: string };
  fuseSlide: { slideId: string; fusionPackId: string; editInstruction?: string };
};

export type DeckIntentKind = keyof DeckIntentParams;

export type DeckIntent = {
  [K in DeckIntentKind]: { kind: K; params: DeckIntentParams[K] };
}[DeckIntentKind];

/**
 * kind → 参数校验器的唯一登记：Record 强制穷尽（新增 kind 忘记登记即编译失败）。
 * 服务端 readIntentParams 用这张表判「是不是 deck 的 kind」，不再另写解析函数。
 */
export const DECK_INTENT_PARAMS: IntentParamsTable<DeckIntentParams> = {
  generateOutline: acceptParams,
  addSlide: acceptParams,
  removeSlide: acceptParams,
  reorderSlides: acceptParams,
  splitSlide: acceptParams,
  updateSlide: acceptParams,
  commitVersion: acceptParams,
  structureSlides: acceptParams,
  structureSlide: acceptParams,
  confirmStructure: acceptParams,
  unlockStructure: acceptParams,
  setStyle: acceptParams,
  setReferenceImage: acceptParams,
  generateSlides: acceptParams,
  retryFailedSlides: acceptParams,
  generateSlide: acceptParams,
  refineSlide: acceptParams,
  eraseSlide: acceptParams,
  editSlideText: acceptParams,
  fuseSlide: acceptParams,
};

export const DECK_INTENT_KINDS = Object.keys(DECK_INTENT_PARAMS) as DeckIntentKind[];

/** 生成类意图返回的 job 句柄（只暴露前端要用的摘要，done 留在服务端） */
export interface DeckJobHandle {
  jobId: string;
  status: 'queued' | 'running';
  total: number;
}

/**
 * 意图 → 响应附带字段：与 actions.ts 每个分支的 extra 一一对应（由 ActionResult<kind> 钉住）。
 * 响应 = 全量 deck 状态 + 本意图的 extra，前端按 kind 取字段，不再从展开对象里猜形状。
 */
export type DeckIntentExtra = {
  generateOutline: { reused: boolean; provider?: string; pageCount?: number };
  addSlide: Record<string, never>;
  removeSlide: Record<string, never>;
  reorderSlides: Record<string, never>;
  splitSlide: { provider: string; into: number };
  updateSlide: { contentChanged: boolean };
  commitVersion: Record<string, never>;
  structureSlides: { reused?: boolean; failedSlides?: string[] };
  structureSlide: { reused?: boolean; failedSlides?: string[] };
  confirmStructure: Record<string, never>;
  unlockStructure: { alreadyUnlocked?: boolean; invalidated?: number; warning?: string };
  setStyle: { note?: string };
  setReferenceImage: { anchorCleared?: boolean; anchorSlideId?: string };
  generateSlides: { job: DeckJobHandle };
  retryFailedSlides: { job: DeckJobHandle };
  generateSlide: { job: DeckJobHandle };
  refineSlide: { job: DeckJobHandle };
  eraseSlide: { job: DeckJobHandle };
  editSlideText: { job: DeckJobHandle };
  fuseSlide: { job: DeckJobHandle };
};
