// 导出中心动作的 typed intent 契约：deck 图片版/可编辑/文字可编辑导出 + 导出报价。
// 上传转可编辑是 multipart，没有 JSON body，不在此契约内（见 docs/DEBUG-HANDBOOK.md §30）。

export type ExportIntentParams = {
  exportDeckImage: { deckId: string };
  exportDeckEditable: { deckId: string; force?: boolean };
  exportDeckTextEditable: { deckId: string; force?: boolean };
  /** 报价三种既有 body 形态；哪一种是报价自身的事，信封只表达参数结构 */
  quoteExport: {
    deckId?: string;
    projectId?: string;
    pageIds?: string[];
    pageId?: string;
    versionId?: string;
  };
};

export type ExportIntentKind = keyof ExportIntentParams;

export type ExportIntent = {
  [K in ExportIntentKind]: { kind: K; params: ExportIntentParams[K] };
}[ExportIntentKind];

export interface ExportActionCall {
  path: string;
  method: 'POST';
  intent: ExportIntent;
}

const DECK_EXPORT_SUFFIX: Record<
  'exportDeckImage' | 'exportDeckEditable' | 'exportDeckTextEditable',
  string
> = {
  exportDeckImage: 'export-image',
  exportDeckEditable: 'export-editable',
  exportDeckTextEditable: 'export-editable-text',
};

/** 意图 → 路由：deck id 在路径上，其余动作落在导出中心路由 */
export function toExportActionCall(intent: ExportIntent): ExportActionCall {
  if (intent.kind === 'quoteExport') {
    return { path: '/api/pptx-exports/quote', method: 'POST', intent };
  }
  return {
    path: `/api/deck/${encodeURIComponent(intent.params.deckId)}/${DECK_EXPORT_SUFFIX[intent.kind]}`,
    method: 'POST',
    intent,
  };
}

function isExportIntentKind(value: string): value is ExportIntentKind {
  return value === 'quoteExport' || Object.prototype.hasOwnProperty.call(DECK_EXPORT_SUFFIX, value);
}

/** 线上护栏：只认已知 kind，params 缺省按空对象；参数深校验留在动作自身 */
export function parseExportIntent(value: unknown): ExportIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { kind?: unknown; params?: unknown };
  if (typeof raw.kind !== 'string' || !isExportIntentKind(raw.kind)) return null;
  const params = raw.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  return { kind: raw.kind, params } as ExportIntent;
}

/** 路由侧取参数：只接受本条路由声明的 kind，错配返回 null（由服务器适配器转 400） */
export function exportIntentParams<K extends ExportIntentKind>(
  expected: K,
  value: unknown,
): ExportIntentParams[K] | null {
  const intent = parseExportIntent(value);
  if (!intent || intent.kind !== expected) return null;
  return intent.params as ExportIntentParams[K];
}
