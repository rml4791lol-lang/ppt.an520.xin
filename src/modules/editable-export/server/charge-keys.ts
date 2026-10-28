// 可编辑导出的扣费键：唯一来源。
//
// 键的形状是接口的一部分 —— 扣费时写进 credit_ledger.idempotency_key，失败退款与懒恢复
// 都靠重新拼出同一个键来命中同一条扣费记录。任何一处拼错都会派生出另一个退款键，
// 表现是「钱扣了没退」，而且不报错（坑见 src/lib/server/credits.ts 的 chargeRefundKeys 注释）。
//
// 两条前缀已被历史账本数据依赖，改动会让在途任务对不上账，故只允许在此处演进。

import { normalizeChargeKey } from '@/lib/server/credits';

export type EditableExportKind = 'editable' | 'editable_text';

const LEDGER_PREFIX: Record<EditableExportKind, string> = {
  editable: 'export-editable',
  editable_text: 'export-editable-text',
};

/** 扣费键前缀（与 credit_ledger 历史记录一致；未知 kind 回落到 editable 档，避免凭空造出新前缀）。 */
export function ledgerPrefixFor(kind: unknown): string {
  return LEDGER_PREFIX[String(kind) as EditableExportKind] ?? LEDGER_PREFIX.editable;
}

/** 一条导出任务的扣费键：<前缀>:<来源 id>:<导出 id>。扣费与退款必须走同一个函数。 */
export function editableChargeKey(input: { kind: unknown; refId: string; exportId: string }): string {
  return normalizeChargeKey(`${ledgerPrefixFor(input.kind)}:${input.refId}:${input.exportId}`);
}
