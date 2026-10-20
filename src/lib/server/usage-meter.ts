// 上游消耗本地计量：每一次真实上游调用（LLM/生图/Codia）落一条记录到
// upstream_usage_records，财务统计据此汇总“本项目实际消耗”，不依赖上游余额接口。
// 记账绝不允许影响主流程：整个写入路径全部 try/catch 吞掉。
// cost_fen 仅在对应单价 env（ANPPT_V2_COST_*，见 generation/config.ts）配置后估算，
// 未配置时保持 NULL——tokens/次数是上游返回的真实数据，金额只是衍生估算。
import { getDb } from './db';
import { getGenerationConfig, type GenerationConfig } from './generation/config';

export type UsageProvider = 'llm-primary' | 'llm-backup' | 'image' | 'image-backup' | 'codia' | 'image2ppt';

export interface UsageRecordInput {
  provider: UsageProvider;
  /** chat / image-generate / image-edit / pdf-to-ppt */
  kind: string;
  model?: string;
  status: 'ok' | 'error';
  promptTokens?: number;
  completionTokens?: number;
  /** 非 token 类计费单位：图片张数、转换任务数 */
  units?: number;
  durationMs?: number;
  error?: string;
}

function estimateCostFen(input: UsageRecordInput, config: GenerationConfig): number | null {
  if (input.provider === 'llm-primary' || input.provider === 'llm-backup') {
    const inRate = input.provider === 'llm-primary' ? config.costLlmInputFenPerMtok : config.costLlmBackupInputFenPerMtok;
    const outRate = input.provider === 'llm-primary' ? config.costLlmOutputFenPerMtok : config.costLlmBackupOutputFenPerMtok;
    if (inRate <= 0 && outRate <= 0) return null;
    const prompt = Math.max(0, input.promptTokens ?? 0);
    const completion = Math.max(0, input.completionTokens ?? 0);
    return Math.round((prompt * inRate + completion * outRate) / 1_000_000);
  }
  if (input.provider === 'image' || input.provider === 'image-backup') {
    const rate = input.provider === 'image' ? config.costImageFenPerCall : config.costImageBackupFenPerCall;
    if (rate <= 0) return null;
    return rate * Math.max(1, input.units ?? 1);
  }
  if (input.provider === 'codia') {
    if (config.costCodiaFenPerCall <= 0) return null;
    return config.costCodiaFenPerCall * Math.max(1, input.units ?? 1);
  }
  if (input.provider === 'image2ppt') {
    if (config.costImage2PptFenPerPage <= 0) return null;
    return config.costImage2PptFenPerPage * Math.max(1, input.units ?? 1);
  }
  return null;
}

export function recordUpstreamUsage(input: UsageRecordInput): void {
  try {
    const config = getGenerationConfig();
    getDb().prepare(
      `INSERT INTO upstream_usage_records
         (provider, kind, model, status, prompt_tokens, completion_tokens, units, cost_fen, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.provider,
      input.kind,
      String(input.model ?? '').slice(0, 120),
      input.status,
      Math.max(0, Math.floor(input.promptTokens ?? 0)),
      Math.max(0, Math.floor(input.completionTokens ?? 0)),
      Math.max(0, Math.floor(input.units ?? 0)),
      estimateCostFen(input, config),
      Math.max(0, Math.floor(input.durationMs ?? 0)),
      String(input.error ?? '').slice(0, 300),
      Date.now(),
    );
  } catch {
    // 计量失败不挡主流程
  }
}
