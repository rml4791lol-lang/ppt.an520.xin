import { createHash, randomBytes } from 'node:crypto';
import { getDb, withTransaction } from './db';
import { getEnv } from './env';
import { ApiError, validationError } from './http';
import { getDefaultCtx } from '@/lib/plugin/default';
import { actionKeyForAction, type PricingService } from '@/lib/plugin/contracts/pricing';

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
 * 扣费键归一（trim + 128 上限）：域键模块与扣费/退款必须同一口径，
 * 否则键模块产出的键写进行、扣费时却被截断，恢复按存储键拼出的退款键会找不到扣费行。
 * @internal 只供 `*-charge-keys.ts` 与扣费/退款路径使用；业务代码经域键模块取键。
 */
export function normalizeChargeKey(rawChargeKey: unknown): string {
  return cleanKey(rawChargeKey);
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

/** 按页计价的动作；其余动作（如 outline）固定 1 页。 */
const PER_PAGE_ACTIONS = new Set([
  'deck_page_generate',
  'deck_page_refine',
  'export_editable',
  'export_editable_text',
  'single_page_generate',
  'single_page_refine',
]);

/**
 * 估价与扣费的唯一读价点：只认 ctx.pricing（换实现即换价），本文件不存任何价格数字。
 * 调用方在任务启动时调一次并把 unitPrice 快照带进后续扣费/退款，避免两次读价之间漂移。
 */
export function estimateCredits(input: EstimateInput) {
  const action = String(input.action || '').trim();
  const actionKey = action ? actionKeyForAction(action) : null;
  const pricing = getDefaultCtx().use<PricingService>('pricing');
  // 一次任务只读一次价表：先 table() 校验再 quote() 取值会走两次服务方法，换 DB 实现时可能读到两个版本。
  const priceTable = pricing.table();
  if (!actionKey || !(actionKey in priceTable)) throw validationError('未知的计费动作');
  let pages = 1;
  if (PER_PAGE_ACTIONS.has(action)) {
    pages = Math.floor(Number(input.pages) || 0);
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100) {
      throw validationError('页数需为 1-100 的整数');
    }
  }
  const unitPrice = priceTable[actionKey] ?? 0;
  return { action, unitPrice, pages, credits: unitPrice * pages };
}
