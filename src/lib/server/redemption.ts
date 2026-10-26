import { randomBytes } from 'node:crypto';
import { getDb, withTransaction } from './db';
import { ApiError, validationError } from './http';
import { sha256 } from './auth';
import { grantCreditsTx } from './credits';
import { hitRateLimit } from './rate-limit';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_GROUPS = 3;
const CODE_GROUP_LENGTH = 4;

function safeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function normalizeRedemptionCode(input: unknown): string {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function hashRedemptionCode(normalizedCode: string): string {
  return sha256(`redemption:${normalizedCode}`);
}

function generatePlainCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < CODE_GROUP_LENGTH; i += 1) {
      group += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return `ANPPT-${groups.join('-')}`;
}

function invalidCodeError(): ApiError {
  return new ApiError('REDEMPTION_INVALID', '兑换码无效或已被使用', 400, false);
}

type CodeRow = Record<string, string | number | null>;

function findActiveCode(codeHash: string): CodeRow | undefined {
  const row = getDb().prepare('SELECT * FROM redemption_codes WHERE code_hash = ?').get(codeHash) as
    | CodeRow
    | undefined;
  if (!row) return undefined;
  const ts = Date.now();
  const usable = row.disabled_at == null
    && (row.expires_at == null || Number(row.expires_at) > ts)
    && Number(row.uses) < Number(row.max_uses);
  return usable ? row : undefined;
}

export function previewRedemption(code: unknown): { credits: number; requiresConfirmation: true } {
  const normalized = normalizeRedemptionCode(code);
  if (!normalized) throw validationError('请输入兑换码');
  const row = findActiveCode(hashRedemptionCode(normalized));
  if (!row) throw invalidCodeError();
  return { credits: Number(row.credits), requiresConfirmation: true };
}

export interface RedeemResult {
  credits: number;
  balance: number;
}

export function redeemCode(userId: string, code: unknown, clientIp = 'unknown'): RedeemResult {
  const normalized = normalizeRedemptionCode(code);
  if (!normalized) throw validationError('请输入兑换码');

  const rate = hitRateLimit(`redeem:${userId}:${clientIp}`, { windowMs: 60 * 60 * 1000, max: 20 });
  if (!rate.allowed) throw new ApiError('REDEMPTION_RATE_LIMITED', '兑换过于频繁，请稍后再试', 429, true);

  const db = getDb();
  return withTransaction(db, () => {
    const row = db.prepare('SELECT * FROM redemption_codes WHERE code_hash = ?').get(hashRedemptionCode(normalized)) as
      | CodeRow
      | undefined;
    if (!row) throw invalidCodeError();

    const codeId = String(row.id);
    const already = db
      .prepare('SELECT 1 FROM redemption_records WHERE code_id = ? AND user_id = ?')
      .get(codeId, userId);
    if (already) throw new ApiError('REDEMPTION_ALREADY_USED', '你已经兑换过该码', 409, false);

    const ts = Date.now();
    const active = row.disabled_at == null
      && (row.expires_at == null || Number(row.expires_at) > ts)
      && Number(row.uses) < Number(row.max_uses);
    if (!active) throw invalidCodeError();

    const credits = Number(row.credits);
    const idempotencyKey = `redeem:${codeId}:${userId}`;

    const consumed = db
      .prepare(
        `UPDATE redemption_codes SET uses = uses + 1
         WHERE id = ? AND disabled_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)
           AND uses < max_uses`,
      )
      .run(codeId, ts);
    if (consumed.changes !== 1) throw invalidCodeError();

    db.prepare(
      `INSERT INTO redemption_records (id, code_id, user_id, credits, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(safeId('redeem'), codeId, userId, credits, idempotencyKey, ts);

    const grant = grantCreditsTx(userId, credits, {
      reason: `兑换码入账 ${credits} 🌟`,
      idempotencyKey,
      bucket: 'redemption',
      eventType: 'redemption',
      refType: 'redemption_code',
      refId: codeId,
    });
    return { credits, balance: grant.balance };
  });
}

export interface GenerateCodesInput {
  credits: number;
  count: number;
  batch?: string;
  expiresAt?: number | null;
}

export function generateRedemptionCodes(input: GenerateCodesInput): string[] {
  const credits = Math.floor(Number(input.credits));
  const count = Math.floor(Number(input.count));
  if (!Number.isSafeInteger(credits) || credits <= 0) throw validationError('credits 需为正整数');
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw validationError('count 需为 1-1000');
  const batch = String(input.batch ?? '').trim().slice(0, 64);
  const expiresAt = input.expiresAt == null ? null : Number(input.expiresAt);

  const db = getDb();
  const codes: string[] = [];
  withTransaction(db, () => {
    const ts = Date.now();
    for (let i = 0; i < count; i += 1) {
      let inserted = false;
      for (let attempt = 0; attempt < 10 && !inserted; attempt += 1) {
        const plain = generatePlainCode();
        const changed = db
          .prepare(
            `INSERT OR IGNORE INTO redemption_codes (id, code_hash, batch, credits, max_uses, uses, expires_at, disabled_at, created_at)
             VALUES (?, ?, ?, ?, 1, 0, ?, NULL, ?)`,
          )
          .run(safeId('code'), hashRedemptionCode(normalizeRedemptionCode(plain)), batch, credits, expiresAt, ts);
        if (changed.changes === 1) {
          codes.push(plain);
          inserted = true;
        }
      }
      if (!inserted) throw new ApiError('INTERNAL_ERROR', '兑换码生成冲突，请重试', 500, true);
    }
  });
  return codes;
}
