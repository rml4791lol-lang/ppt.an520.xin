import { createHash, randomBytes } from 'node:crypto';
import { getDb, withTransaction } from './db';
import { getEnv } from './env';
import { ApiError, validationError } from './http';
import { getDefaultCtx } from '@/lib/plugin/default';
import { getGenerationConfig } from './generation/config';
import { actionKeyForEnvKey, type PricingService } from '@/lib/plugin/contracts/pricing';

export interface LedgerOptions {
  reason: string;
  idempotencyKey: string;
  bucket?: string;
  eventType?: string;
  refType?: string;
  refId?: string;
}

export interface LedgerWriteResult {
  balance: number;
  duplicate: boolean;
  ledgerId: string;
}

function safeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function cleanAmount(amount: unknown): number {
  const n = Number(amount);
  if (!Number.isSafeInteger(n) || n <= 0) throw validationError('积分数量不合法');
  return n;
}

function cleanKey(key: unknown): string {
  const k = String(key ?? '').trim();
  if (!k) throw validationError('缺少幂等键');
  return k.slice(0, 128);
}

/**
 * 扣费键 + 与之配对的退款幂等键（两者都按 cleanKey 归一）。
 * 退款键必须是定长派生值：写成 `${chargeKey}:refund` 时，超长 chargeKey 先被截成 128 字符、
 * 拼后缀后又截回同一个键，退款会命中扣费行被当作 duplicate 静默吞掉（不退星、无日志）。
 */
export function chargeRefundKeys(rawChargeKey: unknown): { chargeKey: string; refundKey: string } {
  const chargeKey = cleanKey(rawChargeKey);
  const refundKey = `refund:${createHash('sha256').update(chargeKey).digest('hex').slice(0, 32)}`;
  if (refundKey === chargeKey) throw new Error('退款幂等键与扣费键相同，拒绝扣费');
  return { chargeKey, refundKey };
}

/** 已存库的扣费键 → 退款幂等键（懒恢复按 ledger 实扣金额补退；与正常失败退款同键，不双退）。 */
export function deriveRefundKey(rawChargeKey: unknown): string {
  return chargeRefundKeys(rawChargeKey).refundKey;
}

function readBalance(userId: string): number {
  const row = getDb().prepare('SELECT balance FROM credit_wallets WHERE user_id = ?').get(userId);
  return row ? Number(row.balance) : 0;
}

function findLedgerByKey(idempotencyKey: string): Record<string, unknown> | undefined {
  return getDb().prepare('SELECT * FROM credit_ledger WHERE idempotency_key = ?').get(idempotencyKey) as
    | Record<string, unknown>
    | undefined;
}

function appendLedgerTx(
  userId: string,
  delta: number,
  balanceAfter: number,
  opts: LedgerOptions,
): string {
  const id = safeId('ledger');
  getDb()
    .prepare(
      `INSERT INTO credit_ledger
        (id, user_id, delta, balance_after, bucket, reason, idempotency_key, event_type, ref_type, ref_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      userId,
      delta,
      balanceAfter,
      opts.bucket || 'purchased',
      String(opts.reason || '').slice(0, 200),
      opts.idempotencyKey,
      opts.eventType || (delta >= 0 ? 'grant' : 'debit'),
      opts.refType || '',
      opts.refId || '',
      Date.now(),
    );
  return id;
}

export function grantCreditsTx(userId: string, amount: number, opts: LedgerOptions): LedgerWriteResult {
  const credits = cleanAmount(amount);
  const idempotencyKey = cleanKey(opts.idempotencyKey);
  const existing = findLedgerByKey(idempotencyKey);
  if (existing) {
    return { balance: readBalance(userId), duplicate: true, ledgerId: String(existing.id) };
  }
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO credit_wallets (user_id, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at`,
    )
    .run(userId, credits, now);
  const balance = readBalance(userId);
  const ledgerId = appendLedgerTx(userId, credits, balance, { ...opts, idempotencyKey });
  return { balance, duplicate: false, ledgerId };
}

export function debitCreditsTx(userId: string, amount: number, opts: LedgerOptions): LedgerWriteResult {
  const credits = cleanAmount(amount);
  const idempotencyKey = cleanKey(opts.idempotencyKey);
  const existing = findLedgerByKey(idempotencyKey);
  if (existing) {
    return { balance: readBalance(userId), duplicate: true, ledgerId: String(existing.id) };
  }
  const now = Date.now();
  const updated = getDb()
    .prepare('UPDATE credit_wallets SET balance = balance - ?, updated_at = ? WHERE user_id = ? AND balance >= ?')
    .run(credits, now, userId, credits);
  if (updated.changes !== 1) {
    throw new ApiError('INSUFFICIENT_CREDITS', '🌟 星星不足，请充值后继续', 402, false);
  }
  const balance = readBalance(userId);
  const ledgerId = appendLedgerTx(userId, -credits, balance, { ...opts, idempotencyKey });
  return { balance, duplicate: false, ledgerId };
}

export function grantCredits(userId: string, amount: number, opts: LedgerOptions): LedgerWriteResult {
  return withTransaction(getDb(), () => grantCreditsTx(userId, amount, opts));
}

export function debitCredits(userId: string, amount: number, opts: LedgerOptions): LedgerWriteResult {
  return withTransaction(getDb(), () => debitCreditsTx(userId, amount, opts));
}

export function refundCredits(userId: string, amount: number, opts: LedgerOptions): LedgerWriteResult {
  return withTransaction(getDb(), () =>
    grantCreditsTx(userId, amount, { ...opts, eventType: opts.eventType || 'refund' }),
  );
}

export function grantSignupBonusTx(userId: string): LedgerWriteResult {
  const bonus = getEnv().signupBonusCredits;
  return grantCreditsTx(userId, bonus, {
    reason: `注册赠送 ${bonus} 🌟`,
    idempotencyKey: `signup-bonus:${userId}`,
    bucket: 'bonus',
    eventType: 'signup_bonus',
    refType: 'user',
    refId: userId,
  });
}

export function getBalance(userId: string): number {
  return readBalance(userId);
}

export interface LedgerQuery {
  page?: number;
  pageSize?: number;
}

export function listLedger(userId: string, query: LedgerQuery = {}) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  const total = Number(
    getDb().prepare('SELECT COUNT(*) AS c FROM credit_ledger WHERE user_id = ?').get(userId)?.c || 0,
  );
  const rows = getDb()
    .prepare(
      `SELECT id, delta, balance_after, bucket, reason, event_type, ref_type, ref_id, created_at
       FROM credit_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(userId, pageSize, (page - 1) * pageSize);
  const items = rows.map((row) => ({
    id: String(row.id),
    delta: Number(row.delta),
    balanceAfter: Number(row.balance_after),
    bucket: String(row.bucket),
    reason: String(row.reason),
    eventType: String(row.event_type),
    refType: String(row.ref_type),
    refId: String(row.ref_id),
    createdAt: Number(row.created_at),
  }));
  return { items, total, page, pageSize };
}

export function creditsSummary(userId: string) {
  const db = getDb();
  const since30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const sum = (sign: string, since: number): number => {
    const row = db
      .prepare(`SELECT COALESCE(SUM(delta), 0) AS s FROM credit_ledger WHERE user_id = ? AND delta ${sign} 0 AND created_at >= ?`)
      .get(userId, since);
    return Math.abs(Number(row?.s || 0));
  };
  return {
    balance: readBalance(userId),
    totalGranted: sum('>', 0),
    totalSpent: sum('<', 0),
    granted30d: sum('>', since30d),
    spent30d: sum('<', since30d),
  };
}

export interface EstimateInput {
  action: string;
  pages?: number;
}

export function estimateCredits(input: EstimateInput) {
  const prices = getEnv().creditActionPrices;
  const action = String(input.action || '').trim();
  // 单页生成/改图的价格在生成链配置（ANPPT_V2_SINGLE_PAGE_CREDITS），不进动作价目表：
  // 客户端展示与实际扣费读同一个值，不硬编码 10/20 造成覆盖后漂移。
  const configPrice =
    action === 'single_page_generate' || action === 'single_page_refine'
      ? getGenerationConfig().singlePageCredits
      : null;
  if (!action || (configPrice === null && !(action in prices))) throw validationError('未知的计费动作');
  // 生产读价走插件服务键（插件内部仍读同一 env 覆盖链，数字不变）；
  // 未映射插件动作键的自定义 env 键回退直读，兼容 CREDIT_ACTION_PRICES 扩展。
  const actionKey = actionKeyForEnvKey(action);
  const unitPrice = configPrice ?? (actionKey
    ? getDefaultCtx().use<PricingService>('pricing').quote(actionKey)
    : prices[action]);
  let pages = 1;
  if (
    action === 'deck_page_generate'
    || action === 'deck_page_refine'
    || action === 'export_editable'
    || action === 'export_editable_text'
    || configPrice !== null
  ) {
    pages = Math.floor(Number(input.pages) || 0);
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100) {
      throw validationError('页数需为 1-100 的整数');
    }
  }
  return { action, unitPrice, pages, credits: unitPrice * pages };
}
