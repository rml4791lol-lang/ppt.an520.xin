// 导出中心动作的 typed intent 契约：deck 图片版/可编辑/文字可编辑导出 + 导出报价。
// 上传转可编辑是 multipart，没有 JSON body，不在此契约内（见 docs/DEBUG-HANDBOOK.md §30）。
import { acceptParams, type IntentParamsTable } from './intent-envelope';

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
}

/** kind → 参数校验器的唯一登记：服务端 readIntentParams 用这张表判本契约的 kind */
export const EXPORT_INTENT_PARAMS: IntentParamsTable<ExportIntentParams> = {
  exportDeckImage: acceptParams,
  exportDeckEditable: acceptParams,
  exportDeckTextEditable: acceptParams,
  quoteExport: acceptParams,
};

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
    return { path: '/api/pptx-exports/quote', method: 'POST' };
  }
  return {
    path: `/api/deck/${encodeURIComponent(intent.params.deckId)}/${DECK_EXPORT_SUFFIX[intent.kind]}`,
    method: 'POST',
  };
}
