// 计费运行（paid run）：一次收费生成动作的权威顺序与补偿，只有这一份。
//
// 顺序不可调换：落 claim 行 → 注册在飞 → 幂等扣费 → 执行 → 成功置终态；
// 失败先按 ledger 实扣金额退款（幂等）再置 failed。反过来（先终态后退款）崩在中间会
// 留下「终态但没有退款」的行，恢复再也看不见它 —— 表现是钱扣了不退且不报错。
//
// 扣费键由域键模块产出（整套见 charge-keys.ts，前缀是历史账本契约），本模块只消费键：
// claim 时把键写进域行，恢复优先读存储键，退款键统一由 credits.deriveRefundKey 定长派生。
// 在飞注册表也在本模块：域代码不再手调 mark 函数，批次作用域用 withInFlightRun，
// 单次运行在 beginPaidRun 内自动登记/释放。判活（心跳过期）仍归恢复入口。
import { ApiError, validationError } from '../http';
import { logProblem } from '../problem-log';
import { debitCredits, deriveRefundKey, refundCredits } from '../credits';
import { getDb } from '../db';

export interface PaidRunFailure {
  code: string;
  message: string;
}

/** 域适配器只做三件事：落 claim 行、更新本域状态、置终态；不碰扣费/退款/心跳注册。 */
export interface PaidRunStore<TRow, TResult> {
  claim(chargeKey: string): TRow;
  markRunning?(row: TRow): void;
  markSucceeded(row: TRow, result: TResult): void;
  markFailed(row: TRow, failure: PaidRunFailure): void;
}

export interface PaidRunInput<TRow, TResult> {
  /** 域标识（deck / single-page / editable-export / ppt-to-base） */
  domain: string;
  userId: string;
  /** 计费动作（价格表键，只用于在飞清单与日志，不读价） */
  action: string;
  /** 启动时定格一次的单价快照：扣费与失败退款都按它，运行中换价不影响在途任务 */
  unitPrice: number;
  /** 域键模块产出的扣费键 */
  chargeKey: string;
  refType: string;
  refId: string;
  reason: string;
  refundReason: string;
  store: PaidRunStore<TRow, TResult>;
  now?: () => number;
}

export interface ChargedPaidRun<TRow, TResult> {
  row: TRow;
  succeed(result: TResult): void;
  fail(failure: PaidRunFailure): void;
}

export type BeginPaidRunResult<TRow, TResult> =
  | { charged: true; run: ChargedPaidRun<TRow, TResult> }
  | { charged: false; failure: PaidRunFailure };

interface InFlightEntry {
  runId: string;
  domain: string;
  userId: string;
  action: string;
  startedAt: number;
  count: number;
}

const inFlight = new Map<string, InFlightEntry>();

export interface InFlightScope {
  runId: string;
  domain?: string;
  userId?: string;
  action?: string;
  now?: () => number;
}

/** 登记一条在飞运行（同键并发只加计数）；批次用 withInFlightRun，单次运行由 beginPaidRun 登记。 */
export function holdInFlight(scope: InFlightScope): void {
  const runId = String(scope.runId || '').trim();
  if (!runId) throw validationError('缺少在飞运行标识');
  const existing = inFlight.get(runId);
  if (existing) {
    existing.count += 1;
    return;
  }
  inFlight.set(runId, {
    runId,
    domain: String(scope.domain || ''),
    userId: String(scope.userId || ''),
    action: String(scope.action || ''),
    startedAt: (scope.now ?? Date.now)(),
    count: 1,
  });
}

export function releaseInFlight(runId: string): void {
  const key = String(runId || '').trim();
  const entry = inFlight.get(key);
  if (!entry) return;
  entry.count -= 1;
  if (entry.count <= 0) inFlight.delete(key);
}

/** 本进程是否仍在跑这条运行（恢复判活的注册表口径）。 */
export function isInFlight(runId: string): boolean {
  return inFlight.has(String(runId || '').trim());
}

/** 该用户在本进程的在途运行清单（评审/排障用：能直接构造「已扣费未完成」现场）。 */
export function listInFlight(userId?: string): Omit<InFlightEntry, 'count'>[] {
  const entries = [...inFlight.values()];
  const scoped = userId === undefined ? entries : entries.filter((entry) => entry.userId === userId);
  return scoped.map(({ runId, domain, userId: owner, action, startedAt }) => ({ runId, domain, userId: owner, action, startedAt }));
}

/** 批次级在飞作用域：整套生成一次 job 的存活期覆盖蓝图与逐页执行，结束/抛错都释放。 */
export async function withInFlightRun<T>(scope: InFlightScope, execute: () => Promise<T>): Promise<T> {
  holdInFlight(scope);
  try {
    return await execute();
  } finally {
    releaseInFlight(scope.runId);
  }
}

/**
 * 开始一次计费运行。返回 charged=false 表示未扣费（行已置 failed，无需退款）。
 * 扣费成功即自动登记在飞；调用方只能用返回的 succeed/fail 收尾。
 */
export function beginPaidRun<TRow, TResult>(input: PaidRunInput<TRow, TResult>): BeginPaidRunResult<TRow, TResult> {
  const chargeKey = String(input.chargeKey || '').trim();
  if (!chargeKey) throw validationError('缺少扣费键');
  // 先落 claim 行：扣费一旦发生，行上必有键可供恢复退款
  const row = input.store.claim(chargeKey);
  holdInFlight({
    runId: chargeKey,
    domain: input.domain,
    userId: input.userId,
    action: input.action,
    now: input.now,
  });

  try {
    debitCredits(input.userId, input.unitPrice, {
      reason: input.reason,
      idempotencyKey: chargeKey,
      refType: input.refType,
      refId: input.refId,
    });
  } catch (error) {
    const failure = chargeFailure(error);
    try {
      input.store.markFailed(row, failure);
    } finally {
      releaseInFlight(chargeKey);
    }
    return { charged: false, failure };
  }

  try {
    input.store.markRunning?.(row);
  } catch {
    // 已扣费但域状态写不进去：按失败收敛，钱先退回，不留「扣了费没跑」的行
    const failure: PaidRunFailure = { code: 'CHARGE_FAILED', message: '扣费后运行状态写入失败，已退回' };
    try {
      refundChargedRun({
        userId: input.userId,
        chargeKey,
        reason: input.refundReason,
        refType: input.refType,
        refId: input.refId,
      });
      input.store.markFailed(row, failure);
    } finally {
      releaseInFlight(chargeKey);
    }
    return { charged: false, failure };
  }

  return {
    charged: true,
    run: {
      row,
      succeed(result: TResult): void {
        try {
          input.store.markSucceeded(row, result);
        } finally {
          releaseInFlight(chargeKey);
        }
      },
      fail(failure: PaidRunFailure): void {
        try {
          refundChargedRun({
            userId: input.userId,
            chargeKey,
            reason: input.refundReason,
            refType: input.refType,
            refId: input.refId,
          });
          input.store.markFailed(row, failure);
        } finally {
          releaseInFlight(chargeKey);
        }
      },
    },
  };
}

export interface SettlePaidRunInput {
  userId: string;
  chargeKey?: string;
  refundReason: string;
  refType: string;
  refId: string;
  /** 置失败终态（幂等）。恢复入口判定中断后调用；成功终态不走这里。 */
  settle: () => void;
}

/** 失败/中断的收敛：先按实扣金额退款（幂等，已退过就跳过），再置 failed。 */
export function failPaidRun(input: SettlePaidRunInput): void {
  const chargeKey = String(input.chargeKey || '').trim();
  if (chargeKey) {
    refundChargedRun({
      userId: input.userId,
      chargeKey,
      reason: input.refundReason,
      refType: input.refType,
      refId: input.refId,
    });
  }
  try {
    input.settle();
  } finally {
    if (chargeKey) releaseInFlight(chargeKey);
  }
}

function chargeFailure(error: unknown): PaidRunFailure {
  if (error instanceof ApiError && error.code === 'INSUFFICIENT_CREDITS') {
    return { code: 'INSUFFICIENT_CREDITS', message: error.message };
  }
  return { code: 'CHARGE_FAILED', message: error instanceof Error ? error.message : String(error) };
}

interface RefundChargedRunInput {
  userId: string;
  chargeKey: string;
  reason: string;
  refType: string;
  refId: string;
}

/**
 * 按 ledger 实扣金额补退款：退款键定长派生、已退过跳过，金额取扣费行 delta
 * （不取单价快照——重放/迟到扣费时两者可能不同），返回实际退回金额。
 */
function refundChargedRun(input: RefundChargedRunInput): number {
  const refundKey = deriveRefundKey(input.chargeKey);
  const ledger = getDb();
  if (ledger.prepare('SELECT 1 FROM credit_ledger WHERE idempotency_key = ?').get(refundKey)) return 0;
  const debit = ledger.prepare('SELECT delta FROM credit_ledger WHERE idempotency_key = ?').get(input.chargeKey) as
    | { delta: number }
    | undefined;
  if (!debit) return 0;
  const amount = Math.abs(Number(debit.delta));
  if (amount <= 0) return 0;
  try {
    refundCredits(input.userId, amount, {
      reason: input.reason,
      idempotencyKey: refundKey,
      refType: input.refType,
      refId: input.refId,
    });
    return amount;
  } catch (error) {
    logProblem({
      category: 'generation',
      level: 'error',
      message: '退款失败（按实扣金额补退）',
      detail: `chargeKey=${input.chargeKey} reason=${input.reason} error=${error instanceof Error ? error.message : String(error)}`,
      userId: input.userId,
      refType: input.refType,
      refId: input.refId,
    });
    return 0;
  }
}
