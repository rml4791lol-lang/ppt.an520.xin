// 生成链崩溃恢复（懒触发）。
// 背景：deploy 重启/进程崩溃会打断在途生成——deck 卡 generating（409 死锁）、
// 页面卡 queued/running（不在默认重生成范围）、已扣费页没有退款（退款逻辑在
// 内存 catch 里，进程死了不执行）。本模块在状态被读取时把中断状态收敛回可
// 重试，并按 ledger 实扣金额补退款（refund 幂等键与正常失败退款一致，不双退）。
// 判定依据：job 心跳（每页完成时更新 updated_at）超时或已终态 = 进程已死；
// 本进程活跃任务有注册表守卫，绝不动活跃任务。
import { getDb } from '../db';
import { deriveRefundKey, refundCredits } from '../credits';
import { logProblem } from '../problem-log';
import { getGenDb, nowMs } from './db';
import { getGenerationConfig } from './config';
import type { DeckRow } from './decks';

// ---- 本进程活跃任务注册表（generate.ts / single-pages.ts 注册） ----

const activeJobs = new Set<string>();

export function markJobActive(jobId: string): void {
  activeJobs.add(jobId);
}

export function markJobDone(jobId: string): void {
  activeJobs.delete(jobId);
}

const activeSinglePages = new Set<string>();

export function markSinglePageActive(pageId: string): void {
  activeSinglePages.add(pageId);
}

export function markSinglePageDone(pageId: string): void {
  activeSinglePages.delete(pageId);
}

/** 心跳过期判定：超过 jobStaleMs 视为原进程已死（懒恢复唯一的时间口径） */
export function isStale(heartbeatMs: number): boolean {
  return Number(heartbeatMs) < nowMs() - getGenerationConfig().jobStaleMs;
}

function jobStillLive(jobId: string): boolean {
  if (!jobId) return false;
  if (activeJobs.has(jobId)) return true;
  const job = getGenDb()
    .prepare('SELECT status, updated_at FROM generation_jobs WHERE id = ?')
    .get(jobId) as { status: string; updated_at: number } | undefined;
  if (!job || !['queued', 'running'].includes(String(job.status))) return false;
  return !isStale(Number(job.updated_at));
}

/** 按 ledger 实扣金额补退款（幂等键 = 正常退款键，重复执行/已退过都不双退） */
export function refundCharge(
  chargeKey: string,
  userId: string,
  reason: string,
  refType: string,
  refId: string,
): void {
  const refundKey = deriveRefundKey(chargeKey);
  const ledger = getDb();
  if (ledger.prepare('SELECT 1 FROM credit_ledger WHERE idempotency_key = ?').get(refundKey)) return;
  const debit = ledger.prepare('SELECT delta FROM credit_ledger WHERE idempotency_key = ?').get(chargeKey) as
    | { delta: number }
    | undefined;
  if (!debit) return;
  const amount = Math.abs(Number(debit.delta));
  if (amount <= 0) return;
  try {
    refundCredits(userId, amount, { reason, idempotencyKey: refundKey, refType, refId });
  } catch (error) {
    logProblem({
      category: 'generation',
      level: 'error',
      message: '崩溃恢复补退款失败',
      detail: `chargeKey=${chargeKey} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
      userId,
      refType,
      refId,
    });
  }
}

/**
 * 一段被判定为中断的在途任务。判活（job 心跳 / version 心跳 / 注册表）留在各生成类型里，
 * 收敛与补退统一走 reconcileInterrupted——整套 / 单页 / 可编辑导出 / 底座共用一份实现。
 */
export interface InterruptedRun {
  /** 日志用稳定标识（slideId / pageId / exportId） */
  key: string;
  /** 生成类型：deck | single-page | editable-export | ppt-to-base */
  domain: string;
  userId: string;
  /** 已判定中断（无人认领且心跳过期）；false = 仍在途，一概不动 */
  interrupted: boolean;
  /** 已扣费键：有则按 ledger 实扣金额补退（退款键定长派生，重复执行不双退） */
  chargeKey?: string;
  refundReason?: string;
  refType: string;
  refId: string;
  /** 收敛动作（幂等）：置 failed，或重新推进管线（可编辑导出是重跑而不是退星） */
  settle: () => void;
}

/**
 * 唯一收敛实现：中断任务 → 收敛动作 → 按实扣金额补退，返回收敛条数。
 * 调用方（各生成类型的读口）只负责列出在途任务；重复调用幂等。
 */
export function reconcileInterrupted(runs: InterruptedRun[]): number {
  const healed = runs.filter((run) => run.interrupted);
  for (const run of healed) {
    run.settle();
    if (run.chargeKey) {
      refundCharge(run.chargeKey, run.userId, run.refundReason ?? '生成中断退回', run.refType, run.refId);
    }
  }
  if (healed.length > 0) {
    const refs = [...new Set(healed.map((run) => `${run.refType}:${run.refId}`))];
    console.warn(`[anppt-v2][recovery] 收敛中断任务 ${healed.length} 条（${refs.join('、')}）`);
  }
  return healed.length;
}

/**
 * 收敛中断的整套生成（幂等，同步）。deck 状态被读取（getDeckState /
 * startDeckGeneration / listProjects）时触发。返回是否修复了状态（调用方应重读 deck）。
 */
export function reconcileDeckGeneration(deck: Pick<DeckRow, 'id' | 'userId' | 'status'>): boolean {
  const db = getGenDb();
  const stuck = db
    .prepare("SELECT id AS slideId, page_index AS pageIndex FROM deck_slides WHERE deck_id = ? AND gen_status IN ('queued','running')")
    .all(deck.id) as Array<{ slideId: string; pageIndex: number }>;
  if (stuck.length === 0 && deck.status !== 'generating') return false;

  // 整批在途守卫：job 活跃时 queued/running 页全部归属该 job——其 slide_versions 行要等
  // 蓝图/生图调度后才逐页落库，此时收敛会把在途页误置 failed，并按旧版本误退原始扣费。
  if (deck.status === 'generating') {
    const live = db
      .prepare("SELECT id, updated_at FROM generation_jobs WHERE deck_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
      .get(deck.id) as { id: string; updated_at: number } | undefined;
    if (live && (activeJobs.has(String(live.id)) || !isStale(Number(live.updated_at)))) {
      return false;
    }
  }

  const runs: InterruptedRun[] = stuck.map((slide) => {
    const version = db
      .prepare('SELECT id, job_id, status FROM slide_versions WHERE slide_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(slide.slideId) as { id: string; job_id: string; status: string } | undefined;
    const jobId = String(version?.job_id || '');
    return {
      key: slide.slideId,
      domain: 'deck',
      userId: deck.userId,
      interrupted: !jobStillLive(jobId),
      settle: () => {
        if (version && ['queued', 'running'].includes(String(version.status))) {
          db.prepare("UPDATE slide_versions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
            '生成中断（服务重启），请重试本页',
            nowMs(),
            String(version.id),
          );
        }
        db.prepare("UPDATE deck_slides SET gen_status = 'failed', gen_error = ?, updated_at = ? WHERE id = ?").run(
          '生成中断（服务重启），请重试本页',
          nowMs(),
          slide.slideId,
        );
      },
      chargeKey: jobId ? `deck-generate:${deck.id}:${jobId}:${slide.slideId}` : '',
      refundReason: `第 ${slide.pageIndex + 1} 页生成中断退回`,
      refType: 'deck',
      refId: deck.id,
    };
  });

  let healed = reconcileInterrupted(runs) > 0;

  if (deck.status === 'generating') {
    // 活跃 job 已在上方守卫返回；走到这里必是死 job
    db.prepare(
      "UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = ? WHERE deck_id = ? AND status IN ('queued','running')",
    ).run('生成中断（服务重启），已自动恢复为可重试', nowMs(), deck.id);
    const anySucceeded = db
      .prepare("SELECT 1 FROM deck_slides WHERE deck_id = ? AND gen_status IN ('succeeded','stale') LIMIT 1")
      .get(deck.id);
    db.prepare('UPDATE decks SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
      anySucceeded ? 'partial' : 'confirmed',
      '',
      nowMs(),
      deck.id,
    );
    healed = true;
  }
  return healed;
}

/**
 * 收敛中断的单页生成（页 status queued/running 且最新 version 非终态且超时）。
 * 单页无 job 行，用 version.updated_at 近似心跳（单页最坏耗时 = 生图超时）。
 */
export function reconcileSinglePage(userId: string, pageId: string): boolean {
  if (activeSinglePages.has(pageId)) return false;
  const db = getGenDb();
  const page = db
    .prepare('SELECT user_id, status FROM single_pages WHERE id = ? AND user_id = ?')
    .get(pageId, userId) as { user_id: string; status: string } | undefined;
  if (!page || !['queued', 'running'].includes(String(page.status))) return false;
  // 找最新的「在途」version（终态版本不算——页可能 running 而最新版本是历史成功版）
  const version = db
    .prepare("SELECT id, status, charge_key, updated_at FROM single_page_versions WHERE page_id = ? AND status IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(pageId) as { id: string; status: string; charge_key: string; updated_at: number } | undefined;
  if (!version) {
    // 页卡在途但没有在途 version（老数据）：没有版本就没有扣费键可退，直接置 failed
    return reconcileInterrupted([
      {
        key: pageId,
        domain: 'single-page',
        userId: String(page.user_id),
        interrupted: true,
        refType: 'single-page',
        refId: pageId,
        settle: () => {
          db.prepare("UPDATE single_pages SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')").run(
            '生成中断（服务重启），请重试',
            nowMs(),
            pageId,
          );
        },
      },
    ]) > 0;
  }
  return reconcileInterrupted([
    {
      key: pageId,
      domain: 'single-page',
      userId: String(page.user_id),
      interrupted: isStale(Number(version.updated_at)),
      settle: () => {
        db.prepare("UPDATE single_page_versions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
          '生成中断（服务重启），请重试',
          nowMs(),
          String(version.id),
        );
        db.prepare("UPDATE single_pages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
          '生成中断（服务重启），请重试',
          nowMs(),
          pageId,
        );
      },
      chargeKey: String(version.charge_key || ''),
      refundReason: '单页生成中断退回',
      refType: 'single-page',
      refId: pageId,
    },
  ]) > 0;
}
