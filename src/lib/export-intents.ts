// 导出中心动作的 typed intent 契约：deck 图片版/可编辑/文字可编辑导出。
// 上传转可编辑是 multipart，没有 JSON body，不在此契约内（见 docs/DEBUG-HANDBOOK.md §30）。
// 报价路径因无客户端消费方已删除；若未来需要报价，从发起决策同一处派生，不再另写价格计算。
import {
  readIntentFields,
  readRequiredText,
  type IntentParamsTable,
} from './intent-envelope';

export type ExportIntentParams = {
  exportDeckImage: { deckId: string };
  exportDeckEditable: { deckId: string; force?: boolean };
  exportDeckTextEditable: { deckId: string; force?: boolean };
};

export type ExportIntentKind = keyof ExportIntentParams;

export type ExportIntent = {
  [K in ExportIntentKind]: { kind: K; params: ExportIntentParams[K] };
}[ExportIntentKind];

export interface ExportActionCall {
  path: string;
  method: 'POST';
}

/** kind → 参数解析器的唯一登记：deckId 与路由 id 同源，force 做布尔归一 */
export const EXPORT_INTENT_PARAMS: IntentParamsTable<ExportIntentParams> = {
  exportDeckImage: (params) => {
    const f = readIntentFields(params);
    return f.done({ deckId: readRequiredText(f, 'deckId', 80, '缺少 deckId') });
  },
  exportDeckEditable: (params) => {
    const f = readIntentFields(params);
    return f.done({
      deckId: readRequiredText(f, 'deckId', 80, '缺少 deckId'),
      force: f.flag('force'),
    });
  },
  exportDeckTextEditable: (params) => {
    const f = readIntentFields(params);
    return f.done({
      deckId: readRequiredText(f, 'deckId', 80, '缺少 deckId'),
      force: f.flag('force'),
    });
  },
};

const DECK_EXPORT_SUFFIX: Record<ExportIntentKind, string> = {
  exportDeckImage: 'export-image',
  exportDeckEditable: 'export-editable',
  exportDeckTextEditable: 'export-editable-text',
};

/** 意图 → 路由：deck id 在路径上，其余动作落在导出中心路由 */
export function toExportActionCall(intent: ExportIntent): ExportActionCall {
  return {
    path: `/api/deck/${encodeURIComponent(intent.params.deckId)}/${DECK_EXPORT_SUFFIX[intent.kind]}`,
    method: 'POST',
  };
}
