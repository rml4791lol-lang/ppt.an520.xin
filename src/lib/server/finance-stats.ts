// 管理端财务统计：收入（充值订单）+ 内部消费（星星账/兑换码）+ 上游消耗（本地计量账本）。
// 上游消耗口径（用户拍板 2026-08-22）：只汇总本项目自己的 upstream_usage_records
// 逐条计量（engine/images/codia 每次真实上游调用落一条），不拉上游余额接口。
// tokens / 图片张数 / 转换次数是上游返回的真实消耗数据；金额（cost_fen）仅在
// ANPPT_V2_COST_* 单价配置后由 usage-meter 估算，未配置时汇总为 null。
import { getDb } from './db';
import { getGenDb } from './generation/db';

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, string | number | null>;

function numberOf(row: Row | undefined, key: string): number {
  return Number(row?.[key] ?? 0) || 0;
}

/** SUM(cost_fen) 在整组未定价时为 NULL——保留 null 语义（未配置单价 ≠ 花费 0） */
function costOf(row: Row | undefined, key: string): number | null {
  const value = row?.[key];
  return value === null || value === undefined ? null : Number(value) || 0;
}

export interface UpstreamUsageGroup {
  provider: string;
  kind: string;
  /** 模型名——同一 provider 下不同渠道（如便宜的 seedream 与贵的 gpt-image-2）据此分开统计 */
  model: string;
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  units: number;
  costFen: number | null;
}

export interface UpstreamUsageSummary {
  calls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  units: number;
  costFen: number | null;
}

export interface FinanceStats {
  generatedAt: number;
  income: {
    paidOrders: number;
    totalFen: number;
    totalYuan: string;
    creditsIssued: number;
    last30dFen: number;
    byProvider: Array<{ provider: string; orders: number; fen: number; credits: number }>;
  };
  consumption: {
    creditsSpent: number;
    last30dCredits: number;
    byEvent: Array<{ eventType: string; credits: number; count: number }>;
    redeemedCredits: number;
  };
  usage: {
    decks: number;
    singlePageProjects: number;
    generatedImages: number;
    generationJobs: number;
    exportJobs: number;
    editableExports: number;
  };
  /** 上游真实消耗（本项目计量账本 upstream_usage_records 汇总） */
  upstreamUsage: {
    total: UpstreamUsageSummary;
    last30d: UpstreamUsageSummary;
    byProvider: UpstreamUsageGroup[];
  };
}

const USAGE_SUMMARY_SELECT = `
  SELECT COUNT(*) AS calls,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(units), 0) AS units,
         SUM(CASE WHEN status = 'ok' THEN cost_fen END) AS cost_fen
  FROM upstream_usage_records`;

function usageSummaryOf(row: Row | undefined): UpstreamUsageSummary {
  return {
    calls: numberOf(row, 'calls'),
    errors: numberOf(row, 'errors'),
    promptTokens: numberOf(row, 'prompt_tokens'),
    completionTokens: numberOf(row, 'completion_tokens'),
    units: numberOf(row, 'units'),
    costFen: costOf(row, 'cost_fen'),
  };
}

export async function getFinanceStats(): Promise<FinanceStats> {
  const db = getDb();
  const genDb = getGenDb();
  const since30d = Date.now() - 30 * DAY_MS;

  const income = db.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(amount_fen), 0) AS fen, COALESCE(SUM(credits), 0) AS credits
     FROM recharge_orders WHERE status = 'paid'`,
  ).get() as Row;
  const income30d = db.prepare(
    `SELECT COALESCE(SUM(amount_fen), 0) AS fen FROM recharge_orders WHERE status = 'paid' AND paid_at >= ?`,
  ).get(since30d) as Row;
  const byProvider = db.prepare(
    `SELECT provider, COUNT(*) AS orders, COALESCE(SUM(amount_fen), 0) AS fen, COALESCE(SUM(credits), 0) AS credits
     FROM recharge_orders WHERE status = 'paid' GROUP BY provider ORDER BY fen DESC`,
  ).all() as Row[];

  const spent = db.prepare(
    `SELECT COALESCE(SUM(-delta), 0) AS credits, COUNT(*) AS count FROM credit_ledger WHERE delta < 0`,
  ).get() as Row;
  const spent30d = db.prepare(
    `SELECT COALESCE(SUM(-delta), 0) AS credits FROM credit_ledger WHERE delta < 0 AND created_at >= ?`,
  ).get(since30d) as Row;
  const byEvent = db.prepare(
    `SELECT event_type, COALESCE(SUM(-delta), 0) AS credits, COUNT(*) AS count
     FROM credit_ledger WHERE delta < 0 GROUP BY event_type ORDER BY credits DESC`,
  ).all() as Row[];
  const redeemed = db.prepare(
    `SELECT COALESCE(SUM(credits), 0) AS credits FROM redemption_records`,
  ).get() as Row;

  const usage = genDb.prepare(
    `SELECT
       (SELECT COUNT(*) FROM decks WHERE deleted_at IS NULL) AS decks,
       (SELECT COUNT(*) FROM single_page_projects WHERE deleted_at IS NULL) AS single_pages,
       (SELECT COUNT(*) FROM slide_versions WHERE status = 'succeeded') AS images,
       (SELECT COUNT(*) FROM generation_jobs) AS generation_jobs,
       (SELECT COUNT(*) FROM export_jobs) AS export_jobs,
       (SELECT COUNT(*) FROM export_jobs WHERE kind = 'editable') AS editable_exports`,
  ).get() as Row;

  const usageTotal = db.prepare(USAGE_SUMMARY_SELECT).get() as Row;
  const usage30d = db.prepare(`${USAGE_SUMMARY_SELECT} WHERE created_at >= ?`).get(since30d) as Row;
  const usageGroups = db.prepare(
    `SELECT provider, kind, model,
            COUNT(*) AS calls,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(units), 0) AS units,
            SUM(CASE WHEN status = 'ok' THEN cost_fen END) AS cost_fen
     FROM upstream_usage_records
     GROUP BY provider, kind, model
     ORDER BY provider, kind, model`,
  ).all() as Row[];

  return {
    generatedAt: Date.now(),
    income: {
      paidOrders: numberOf(income, 'orders'),
      totalFen: numberOf(income, 'fen'),
      totalYuan: (numberOf(income, 'fen') / 100).toFixed(2),
      creditsIssued: numberOf(income, 'credits'),
      last30dFen: numberOf(income30d, 'fen'),
      byProvider: byProvider.map((row) => ({
        provider: String(row.provider || ''),
        orders: numberOf(row, 'orders'),
        fen: numberOf(row, 'fen'),
        credits: numberOf(row, 'credits'),
      })),
    },
    consumption: {
      creditsSpent: numberOf(spent, 'credits'),
      last30dCredits: numberOf(spent30d, 'credits'),
      byEvent: byEvent.map((row) => ({
        eventType: String(row.event_type || ''),
        credits: numberOf(row, 'credits'),
        count: numberOf(row, 'count'),
      })),
      redeemedCredits: numberOf(redeemed, 'credits'),
    },
    usage: {
      decks: numberOf(usage, 'decks'),
      singlePageProjects: numberOf(usage, 'single_pages'),
      generatedImages: numberOf(usage, 'images'),
      generationJobs: numberOf(usage, 'generation_jobs'),
      exportJobs: numberOf(usage, 'export_jobs'),
      editableExports: numberOf(usage, 'editable_exports'),
    },
    upstreamUsage: {
      total: usageSummaryOf(usageTotal),
      last30d: usageSummaryOf(usage30d),
      byProvider: usageGroups.map((row) => ({
        provider: String(row.provider || ''),
        kind: String(row.kind || ''),
        model: String(row.model || ''),
        calls: numberOf(row, 'calls'),
        errors: numberOf(row, 'errors'),
        promptTokens: numberOf(row, 'prompt_tokens'),
        completionTokens: numberOf(row, 'completion_tokens'),
        units: numberOf(row, 'units'),
        costFen: costOf(row, 'cost_fen'),
      })),
    },
  };
}
