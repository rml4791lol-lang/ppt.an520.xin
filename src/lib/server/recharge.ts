import { randomBytes } from 'node:crypto';
import { getDb, withTransaction } from './db';
import { getEnv } from './env';
import type { RechargePlan } from './env';
import { ApiError, validationError } from './http';
import { grantCreditsTx } from './credits';
import { createWechatNativeOrder, parseWechatPayNotify } from './payments/wechat';
import { createEpayOrder, parseEpayNotify, majorAmountToMinor } from './payments/epay';
import { hitRateLimit } from './rate-limit';

export type OrderProvider = 'wechat' | 'epay' | 'mock';
export type OrderStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

export interface PublicOrder {
  orderNo: string;
  planId: string;
  amountFen: number;
  credits: number;
  status: OrderStatus;
  provider: OrderProvider;
  codeUrl: string;
  checkoutUrl: string;
  createdAt: number;
  paidAt: number | null;
  expiresAt: number;
}

function safeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function newOutTradeNo(): string {
  return `AN${Date.now().toString(36).toUpperCase()}${randomBytes(6).toString('hex').toUpperCase()}`.slice(0, 32);
}

export function listRechargePlans(): RechargePlan[] {
  return getEnv().rechargePlans;
}

/** 任意一笔真实充值成功后，永久解锁附带会员服务。兑换码不计入‘充值一次’。 */
export function hasEverPaid(userId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS ok FROM recharge_orders WHERE user_id = ? AND status = 'paid' LIMIT 1")
    .get(String(userId).trim()) as { ok?: number } | undefined;
  return Boolean(row?.ok);
}

export function findPlan(planId: unknown): RechargePlan {
  const id = String(planId ?? '').trim();
  const plan = getEnv().rechargePlans.find((item) => item.id === id);
  if (!plan) throw validationError('套餐不存在');
  return plan;
}

type OrderRow = Record<string, string | number | null>;

function rowToPublicOrder(row: OrderRow): PublicOrder {
  return {
    orderNo: String(row.out_trade_no),
    planId: String(row.plan_id),
    amountFen: Number(row.amount_fen),
    credits: Number(row.credits),
    status: String(row.status) as OrderStatus,
    provider: String(row.provider) as OrderProvider,
    codeUrl: String(row.code_url || ''),
    checkoutUrl: String(row.checkout_url || ''),
    createdAt: Number(row.created_at),
    paidAt: row.paid_at == null ? null : Number(row.paid_at),
    expiresAt: Number(row.created_at) + getEnv().rechargeOrderTtlMs,
  };
}

function expireIfStale(row: OrderRow): OrderRow {
  if (String(row.status) !== 'pending') return row;
  const deadline = Number(row.created_at) + getEnv().rechargeOrderTtlMs;
  if (Date.now() <= deadline) return row;
  const changed = getDb()
    .prepare("UPDATE recharge_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'")
    .run(Date.now(), String(row.id));
  if (changed.changes === 1) return { ...row, status: 'expired' };
  return row;
}

export interface CreateOrderInput {
  planId: unknown;
  channel: unknown;
}

export interface CreateOrderResult {
  order: PublicOrder;
  mock: boolean;
}

export async function createRechargeOrder(
  userId: string,
  input: CreateOrderInput,
  clientIp: string,
): Promise<CreateOrderResult> {
  const plan = findPlan(input.planId);
  const channel = String(input.channel ?? '').trim().toLowerCase();
  if (channel !== 'wechat' && channel !== 'alipay') throw validationError('请选择微信支付或支付宝');
  const provider: OrderProvider = channel === 'wechat' ? 'wechat' : 'epay';

  const rate = hitRateLimit(`recharge:${userId}:${clientIp}`, { windowMs: 60 * 60 * 1000, max: 20 });
  if (!rate.allowed) throw new ApiError('ORDER_RATE_LIMITED', '下单过于频繁，请稍后再试', 429, true);

  const env = getEnv();
  const ts = Date.now();
  const id = safeId('order');
  const outTradeNo = newOutTradeNo();
  const db = getDb();
  db.prepare(
    `INSERT INTO recharge_orders
      (id, out_trade_no, user_id, plan_id, amount_fen, credits, status, provider, code_url, checkout_url, transaction_id, paid_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, '', '', '', NULL, ?, ?)`,
  ).run(id, outTradeNo, userId, plan.id, plan.amountFen, plan.credits, provider, ts, ts);

  // 支付网关描述勿含 emoji（微信拒收非 BMP）；站内文案仍可用 🌟
  const description = `AnPPT ${plan.label} ${plan.credits}星`;
  let codeUrl = '';
  let checkoutUrl = '';
  let mock = false;

  if (provider === 'wechat') {
    const result = await createWechatNativeOrder(
      { outTradeNo, amountFen: plan.amountFen, description },
      env.wechat,
    );
    if (!result.ok) {
      db.prepare("UPDATE recharge_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), id);
      throw new ApiError('WECHAT_ORDER_FAILED', result.message || '微信支付下单失败', result.status || 502, true);
    }
    codeUrl = String(result.codeUrl || '');
    mock = Boolean(result.mock);
  } else {
    const result = await createEpayOrder(
      { outTradeNo, amountFen: plan.amountFen, name: description, payType: 'alipay', clientIp },
      env.epay,
    );
    if (!result.ok) {
      db.prepare("UPDATE recharge_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), id);
      throw new ApiError('EPAY_ORDER_FAILED', result.message || '支付宝支付下单失败', result.status || 502, true);
    }
    checkoutUrl = String(result.payurl || '');
    if (!checkoutUrl && result.qrcode) codeUrl = String(result.qrcode);
    mock = Boolean(result.mock);
  }

  db.prepare('UPDATE recharge_orders SET code_url = ?, checkout_url = ?, updated_at = ? WHERE id = ?').run(
    codeUrl,
    checkoutUrl,
    Date.now(),
    id,
  );

  const row = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(id) as OrderRow;
  return { order: rowToPublicOrder(row), mock };
}

export function getRechargeOrderForUser(userId: string, orderNo: unknown): PublicOrder {
  const no = String(orderNo ?? '').trim();
  if (!no) throw validationError('缺少订单号');
  const row = getDb().prepare('SELECT * FROM recharge_orders WHERE out_trade_no = ?').get(no) as OrderRow | undefined;
  if (!row || String(row.user_id) !== userId) {
    throw new ApiError('ORDER_NOT_FOUND', '订单不存在', 404, false);
  }
  return rowToPublicOrder(expireIfStale(row));
}

export interface FulfillInput {
  provider: OrderProvider;
  outTradeNo: string;
  transactionId: string;
  amountFen: number;
}

export interface FulfillResult {
  order: PublicOrder;
  duplicate: boolean;
}

export function fulfillOrderPaid(input: FulfillInput): FulfillResult {
  const db = getDb();
  return withTransaction(db, () => {
    const row = db.prepare('SELECT * FROM recharge_orders WHERE out_trade_no = ?').get(input.outTradeNo) as
      | OrderRow
      | undefined;
    if (!row) throw new ApiError('ORDER_NOT_FOUND', '订单不存在', 404, false);
    if (String(row.provider) !== input.provider) {
      throw new ApiError('PAYMENT_MISMATCH', '支付渠道与订单不一致', 400, false);
    }
    if (Number(row.amount_fen) !== Number(input.amountFen)) {
      throw new ApiError('PAYMENT_MISMATCH', '支付金额与订单不一致', 400, false);
    }

    if (String(row.status) === 'paid') {
      const existingTx = String(row.transaction_id || '');
      if (existingTx && existingTx !== input.transactionId) {
        throw new ApiError('PAYMENT_MISMATCH', '支付流水与订单不一致', 400, false);
      }
      return { order: rowToPublicOrder(row), duplicate: true };
    }
    if (String(row.status) !== 'pending') {
      throw new ApiError('ORDER_NOT_PAYABLE', '订单已关闭，无法入账', 409, false);
    }

    const ts = Date.now();
    const updated = db
      .prepare(
        `UPDATE recharge_orders
         SET status = 'paid', transaction_id = ?, paid_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(String(input.transactionId || '').slice(0, 64), ts, ts, String(row.id));
    if (updated.changes !== 1) {
      const fresh = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(String(row.id)) as OrderRow;
      return { order: rowToPublicOrder(fresh), duplicate: true };
    }

    grantCreditsTx(String(row.user_id), Number(row.credits), {
      reason: `充值 ${Number(row.credits)} 🌟（${String(row.plan_id)}）`,
      idempotencyKey: `recharge-order:${String(row.id)}`,
      bucket: 'purchased',
      eventType: 'payment_grant',
      refType: 'recharge_order',
      refId: String(row.id),
    });

    const fresh = db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(String(row.id)) as OrderRow;
    return { order: rowToPublicOrder(fresh), duplicate: false };
  });
}

// --- notify handlers (called by route handlers with raw payloads) ---

const WECHAT_ACK = { code: 'SUCCESS', message: '成功' } as const;

export async function handleWechatNotify(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ status: number; body: { code: string; message: string } }> {
  const config = getEnv().wechat;
  const parsed = await parseWechatPayNotify(rawBody, headers, config);
  if (!parsed.ok) {
    return { status: parsed.status || 400, body: { code: 'FAIL', message: parsed.message || '回调处理失败' } };
  }
  if (parsed.tradeState !== 'SUCCESS') return { status: 200, body: { ...WECHAT_ACK } };
  try {
    fulfillOrderPaid({
      provider: 'wechat',
      outTradeNo: String(parsed.outTradeNo || ''),
      transactionId: String(parsed.transactionId || ''),
      amountFen: Number(parsed.amountFen || 0),
    });
  } catch (error) {
    const message = error instanceof ApiError ? error.message : '入账失败';
    const status = error instanceof ApiError && error.status < 500 ? 200 : 500;
    // 4xx business mismatches are acked with FAIL/200 so wechat stops retrying poisoned callbacks;
    // transient failures return 500 so wechat retries.
    return { status, body: { code: 'FAIL', message } };
  }
  return { status: 200, body: { ...WECHAT_ACK } };
}

export function handleEpayNotify(params: Record<string, string>): string {
  const config = getEnv().epay;
  const parsed = parseEpayNotify(params, config);
  if (!parsed.ok) return 'fail';
  if (!parsed.paid) return 'success';
  const amountFen = majorAmountToMinor(parsed.amount);
  if (amountFen == null) return 'fail';
  try {
    fulfillOrderPaid({
      provider: 'epay',
      outTradeNo: String(parsed.outTradeNo || ''),
      transactionId: String(parsed.tradeNo || ''),
      amountFen,
    });
  } catch (error) {
    console.error('[anppt-v2][epay] fulfill failed:', error instanceof Error ? error.message : error);
    return 'fail';
  }
  return 'success';
}
