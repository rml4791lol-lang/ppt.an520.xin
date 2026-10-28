// 整套生成的逐页扣费键：唯一来源。
//
// 键的形状是接口的一部分 —— 扣费时写进 credit_ledger.idempotency_key，失败退款与懒恢复
// 都靠同一个键命中同一条扣费记录。任何一处重新拼装都可能派生出另一个退款键，表现是
// 「钱扣了没退」而且不报错（坑见 src/lib/server/credits.ts 的 chargeRefundKeys 注释）。
//
// 前缀 deck-generate 已被历史账本数据依赖，改动会让在途任务对不上账，故只允许在此处演进；
// 版本行存下的键才是恢复的权威值，键形演进后老行仍按存储值结算。

export interface DeckChargeKeyInput {
  deckId: string;
  jobId: string;
  slideId: string;
}

/** 一页生成的扣费键：`deck-generate:<deckId>:<jobId>:<slideId>`。页归属 job，故键含 jobId。 */
export function deckChargeKey(input: DeckChargeKeyInput): string {
  return `deck-generate:${input.deckId}:${input.jobId}:${input.slideId}`;
}
