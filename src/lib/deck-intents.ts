// deck action RPC 的类型化意图契约：客户端与路由共用一份，禁止各自复制。
// 旧的无类型入口 {action, ...params} 完全保留；意图只把「合法动作 + 参数结构」表达进类型，
// 由 toDeckActionCall 原样还原成动作名与参数（机制与取舍见 docs/DEBUG-HANDBOOK.md §29）。

export type SlideRole = 'cover' | 'toc' | 'section' | 'content' | 'ending';

/** 路由 body.action 的合法取值（新增动作先登记这里，否则意图通道也表达不出来） */
export type DeckActionName =
  | 'outline'
  | 'add-slide'
  | 'delete-slide'
  | 'reorder-slides'
  | 'split-slide'
  | 'update-slide'
  | 'structure'
  | 'structure-slide'
  | 'confirm-structure'
  | 'unlock-structure'
  | 'style'
  | 'generate'
  | 'generate-slide'
  | 'refine-slide'
  | 'erase-slide'
  | 'text-edit-slide'
  | 'fuse-slide'
  | 'set-reference'
  | 'retry-failed'
  | 'select-slide-version';

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

/** add-slide 的新页草稿（服务端 insertSlide 只读这几个字段） */
export type DeckSlideDraft = Pick<DeckSlidePatch, 'role' | 'title' | 'goal' | 'rawText' | 'visualNote'>;

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

/** 意图 → 既有动作名。必须与 body.action 的 20 个取值一一对应（测试钉住双射） */
export const DECK_INTENT_ACTIONS: Record<DeckIntentKind, DeckActionName> = {
  generateOutline: 'outline',
  addSlide: 'add-slide',
  removeSlide: 'delete-slide',
  reorderSlides: 'reorder-slides',
  splitSlide: 'split-slide',
  updateSlide: 'update-slide',
  commitVersion: 'select-slide-version',
  structureSlides: 'structure',
  structureSlide: 'structure-slide',
  confirmStructure: 'confirm-structure',
  unlockStructure: 'unlock-structure',
  setStyle: 'style',
  setReferenceImage: 'set-reference',
  generateSlides: 'generate',
  retryFailedSlides: 'retry-failed',
  generateSlide: 'generate-slide',
  refineSlide: 'refine-slide',
  eraseSlide: 'erase-slide',
  editSlideText: 'text-edit-slide',
  fuseSlide: 'fuse-slide',
};

export interface DeckActionCall {
  action: DeckActionName;
  params: Record<string, unknown>;
}

/** 意图 → 旧入口的 {action, ...params}：参数原样透传，不裁剪、不补默认值 */
export function toDeckActionCall(intent: DeckIntent): DeckActionCall {
  return { action: DECK_INTENT_ACTIONS[intent.kind], params: intent.params };
}

function isDeckIntentKind(value: string): value is DeckIntentKind {
  return Object.prototype.hasOwnProperty.call(DECK_INTENT_ACTIONS, value);
}

/**
 * 线上护栏：只认已知 kind，params 缺省按空对象。
 * 参数内的深校验留在动作自身，错误码与旧入口完全一致。
 */
export function parseDeckIntent(value: unknown): DeckIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { kind?: unknown; params?: unknown };
  if (typeof raw.kind !== 'string' || !isDeckIntentKind(raw.kind)) return null;
  const params = raw.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  return { kind: raw.kind, params } as DeckIntent;
}
