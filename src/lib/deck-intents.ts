// deck 动作 RPC 的类型化意图契约：客户端与路由共用一份，参数结构只在这里声明。
// 唯一请求形态是 {intent:{kind,params}}；旧 {action,...params} 入口已删除（取舍见 docs/DEBUG-HANDBOOK.md §29）。
import {
  readIntentFields,
  type IntentFieldReader,
  type IntentParamsTable,
} from './intent-envelope';

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

// 解析器的字段上限对齐服务端列宽（chapter 120 / pageType 80 / title 200 / goal·visualNote 500 /
// rawText 8000 / structuredContent 12000 / summary 12×300），解析与落库不会得出两种结论。
const ROLES: readonly SlideRole[] = ['cover', 'toc', 'section', 'content', 'ending'];
const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i;

function readRole(f: IntentFieldReader, key: string): SlideRole | undefined {
  if (!f.has(key)) return undefined;
  const role = f.text(key, 16);
  if ((ROLES as readonly string[]).includes(role)) return role as SlideRole;
  f.fail('role 不合法');
  return undefined;
}

function readRequiredText(f: IntentFieldReader, key: string, max: number, message: string): string {
  const value = f.text(key, max);
  if (!value) f.fail(message);
  return value;
}

/** addSlide 的新页草稿：撤销删除要还原章节，清洗口径与 insertSlide 一致 */
function readSlideDraft(f: IntentFieldReader, key: string): DeckSlideDraft | undefined {
  const draft = f.record(key);
  if (!draft) return undefined;
  const out: DeckSlideDraft = {};
  const role = readRole(draft, 'role');
  if (role) out.role = role;
  if (draft.has('chapter')) out.chapter = draft.text('chapter', 120);
  if (draft.has('title')) out.title = draft.text('title', 200);
  if (draft.has('goal')) out.goal = draft.text('goal', 500);
  if (draft.has('rawText')) out.rawText = draft.text('rawText', 8000);
  if (draft.has('visualNote')) out.visualNote = draft.text('visualNote', 500);
  return out;
}

/** updateSlide 的 patch：只带走出现过的字段（缺省 = 不改），空标题交给落库兜底为「未命名页」 */
function readSlidePatch(f: IntentFieldReader): DeckSlidePatch {
  const patch: DeckSlidePatch = {};
  const role = readRole(f, 'role');
  if (role) patch.role = role;
  if (f.has('chapter')) patch.chapter = f.text('chapter', 120);
  if (f.has('pageType')) patch.pageType = f.text('pageType', 80);
  if (f.has('title')) patch.title = f.text('title', 200);
  if (f.has('goal')) patch.goal = f.text('goal', 500);
  if (f.has('rawText')) patch.rawText = f.text('rawText', 8000);
  if (f.has('summary')) patch.summary = f.list('summary', 300, 12);
  if (f.has('visualNote')) patch.visualNote = f.text('visualNote', 500);
  if (f.has('structuredContent')) {
    const structuredContent = f.text('structuredContent', 12000);
    if (!structuredContent) f.fail('梳理内容不能为空');
    patch.structuredContent = structuredContent;
  }
  return patch;
}

/** 图片字段只回答 dataURL 形状与上限；字节解码与生图仍在动作里 */
function readImageDataUrl(f: IntentFieldReader, key: string, label: string, maxBytes: number): string {
  const dataUrl = f.text(key, maxBytes * 2);
  const match = IMAGE_DATA_URL_RE.exec(dataUrl);
  if (!match) {
    f.fail(`${label} 必须是图片 base64 dataURL`);
    return '';
  }
  const payload = match[1].replace(/\s+/g, '');
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((payload.length * 3) / 4) - padding;
  if (bytes <= 0) {
    f.fail(`${label} 内容为空`);
    return dataUrl;
  }
  if (bytes > maxBytes) {
    f.fail(`${label} 超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`);
  }
  return dataUrl;
}

/**
 * kind → 参数解析器的唯一登记：Record 强制穷尽（新增 kind 忘记登记即编译失败）。
 * 解析器只回答形状与基础字段合法性（类型/上限/布尔归一/数组清洗），
 * 计费、幂等、权限、开关、模板/页是否存在等业务硬门仍由 actions.ts 决定。
 */
export const DECK_INTENT_PARAMS: IntentParamsTable<DeckIntentParams> = {
  generateOutline: (params) => {
    const f = readIntentFields(params);
    return f.done({ force: f.flag('force') });
  },
  addSlide: (params) => {
    const f = readIntentFields(params);
    return f.done({ atIndex: f.int('atIndex'), slide: readSlideDraft(f, 'slide') });
  },
  removeSlide: (params) => {
    const f = readIntentFields(params);
    return f.done({ slideId: readRequiredText(f, 'slideId', 80, '缺少 slideId') });
  },
  reorderSlides: (params) => {
    const f = readIntentFields(params);
    return f.done({ order: f.list('order', 80) });
  },
  splitSlide: (params) => {
    const f = readIntentFields(params);
    const slideId = readRequiredText(f, 'slideId', 80, '缺少 slideId');
    return f.done({ slideId, into: Math.min(5, Math.max(2, f.int('into') ?? 2)) });
  },
  updateSlide: (params) => {
    const f = readIntentFields(params);
    const slideId = readRequiredText(f, 'slideId', 80, '缺少 slideId');
    return f.done({ slideId, ...readSlidePatch(f) });
  },
  commitVersion: (params) => {
    const f = readIntentFields(params);
    const slideId = f.text('slideId', 80);
    const versionId = f.text('versionId', 80);
    if (!slideId || !versionId) f.fail('缺少 slideId 或 versionId');
    return f.done({ slideId, versionId });
  },
  structureSlides: (params) => {
    const f = readIntentFields(params);
    return f.done({ force: f.flag('force') });
  },
  structureSlide: (params) => {
    const f = readIntentFields(params);
    return f.done({ slideId: readRequiredText(f, 'slideId', 80, '缺少 slideId') });
  },
  confirmStructure: (params) => readIntentFields(params).done({}),
  unlockStructure: (params) => readIntentFields(params).done({}),
  setStyle: (params) => {
    const f = readIntentFields(params);
    return f.done({ stylePackId: f.text('stylePackId', 80) });
  },
  setReferenceImage: (params) => {
    const f = readIntentFields(params);
    // null 是「取消全套参考图」的显式取值，不能被洗成空串丢掉语义
    const slideId = f.raw('slideId') === null ? null : f.text('slideId', 80);
    return f.done({ slideId });
  },
  generateSlides: (params) => {
    const f = readIntentFields(params);
    return f.done({ forceRegenerate: f.flag('forceRegenerate') });
  },
  retryFailedSlides: (params) => readIntentFields(params).done({}),
  generateSlide: (params) => {
    const f = readIntentFields(params);
    return f.done({ slideId: readRequiredText(f, 'slideId', 80, '缺少 slideId') });
  },
  refineSlide: (params) => {
    const f = readIntentFields(params);
    const slideId = readRequiredText(f, 'slideId', 80, '缺少 slideId');
    const editInstruction = readRequiredText(f, 'editInstruction', 1000, '缺少 editInstruction');
    return f.done({ slideId, editInstruction });
  },
  eraseSlide: (params) => {
    const f = readIntentFields(params);
    const slideId = readRequiredText(f, 'slideId', 80, '缺少 slideId');
    const markImageDataUrl = readImageDataUrl(f, 'markImageDataUrl', '涂抹标记图', 2 * 1024 * 1024);
    return f.done({ slideId, markImageDataUrl });
  },
  editSlideText: (params) => {
    const f = readIntentFields(params);
    const slideId = readRequiredText(f, 'slideId', 80, '缺少 slideId');
    const editInstruction = readRequiredText(f, 'editInstruction', 1000, '缺少 editInstruction');
    return f.done({ slideId, editInstruction });
  },
  fuseSlide: (params) => {
    const f = readIntentFields(params);
    const slideId = readRequiredText(f, 'slideId', 80, '缺少 slideId');
    const fusionPackId = readRequiredText(f, 'fusionPackId', 120, '缺少 fusionPackId');
    const editInstruction = f.has('editInstruction') ? f.text('editInstruction', 1000) : undefined;
    return f.done({ slideId, fusionPackId, editInstruction });
  },
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
