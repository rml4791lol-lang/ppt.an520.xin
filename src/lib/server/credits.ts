import { randomBytes } from 'node:crypto';
import { getDb, withTransaction } from './db';
import { getEnv } from './env';
import { ApiError, validationError } from './http';

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
  if (!action || !(action in prices)) throw validationError('未知的计费动作');
  const unitPrice = prices[action];
  let pages = 1;
  if (action === 'deck_page_generate') {
    pages = Math.floor(Number(input.pages) || 0);
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 100) {
      throw validationError('页数需为 1-100 的整数');
    }
  }
  return { action, unitPrice, pages, credits: unitPrice * pages };
}
