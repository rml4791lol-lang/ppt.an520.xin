// 单页生成/导出动作的 typed intent 契约：客户端与路由共用一份，动作名即既有路由。
// 旧的无类型 body 完全保留；意图只把「合法动作 + 参数结构」表达进类型，
// 由 toSinglePageActionCall 决定发往哪条路由（机制与取舍见 docs/DEBUG-HANDBOOK.md §29）。

export type SinglePageIntentParams = {
  /** 逐版本生成（10🌟/版）；requestId 用于幂等重放拒绝 */
  generatePage: {
    pageId: string;
    projectId?: string;
    title?: string;
    content: string;
    stylePackId?: string;
    imagePath?: string;
    requestId?: string;
    /** replicate = 复刻分支内部调用，挂 ppt_replicate 开关 */
    mode?: string;
    colorMode?: string;
    structure?: unknown;
  };
  refinePage: { pageId: string; editInstruction: string; requestId?: string };
  selectVersion: { pageId: string; versionId: string };
  exportImagePptx: { projectId?: string; pageIds?: string[]; title?: string };
  exportEditablePptx: { projectId: string; force?: boolean };
};

export type SinglePageIntentKind = keyof SinglePageIntentParams;

export type SinglePageIntent = {
  [K in SinglePageIntentKind]: { kind: K; params: SinglePageIntentParams[K] };
}[SinglePageIntentKind];

export interface SinglePageActionCall {
  path: string;
  method: 'POST';
  intent: SinglePageIntent;
}

const SINGLE_PAGE_PATHS: Record<SinglePageIntentKind, string> = {
  generatePage: '/api/single-page/generate',
  refinePage: '/api/single-page/refine',
  selectVersion: '/api/single-page/select-version',
  exportImagePptx: '/api/single-page/export-image-pptx',
  exportEditablePptx: '/api/single-page/export-editable-pptx',
};

/** 意图 → 路由：路径只在这里出现（客户端分发唯一入口） */
export function toSinglePageActionCall(intent: SinglePageIntent): SinglePageActionCall {
  return { path: SINGLE_PAGE_PATHS[intent.kind], method: 'POST', intent };
}

function isSinglePageIntentKind(value: string): value is SinglePageIntentKind {
  return Object.prototype.hasOwnProperty.call(SINGLE_PAGE_PATHS, value);
}

/** 线上护栏：只认已知 kind，params 缺省按空对象；参数深校验留在动作自身 */
export function parseSinglePageIntent(value: unknown): SinglePageIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { kind?: unknown; params?: unknown };
  if (typeof raw.kind !== 'string' || !isSinglePageIntentKind(raw.kind)) return null;
  const params = raw.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  return { kind: raw.kind, params } as SinglePageIntent;
}

/** 路由侧取参数：只接受本条路由声明的 kind，错配返回 null（由服务器适配器转 400） */
export function singlePageIntentParams<K extends SinglePageIntentKind>(
  expected: K,
  value: unknown,
): SinglePageIntentParams[K] | null {
  const intent = parseSinglePageIntent(value);
  if (!intent || intent.kind !== expected) return null;
  return intent.params as SinglePageIntentParams[K];
}
