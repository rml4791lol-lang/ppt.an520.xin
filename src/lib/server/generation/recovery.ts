// 生成链崩溃恢复（懒触发）。
// 背景：deploy 重启/进程崩溃会打断在途生成——deck 卡 generating（409 死锁）、
// 页面卡 queued/running（不在默认重生成范围）、已扣费页没有退款（退款逻辑在
// 内存 catch 里，进程死了不执行）。本模块在状态被读取时把中断状态收敛回可
// 重试，并按 ledger 实扣金额补退款（refund 幂等键与正常失败退款一致，不双退）。
// 判定依据：job 心跳（每页完成时更新 updated_at）超时或已终态 = 进程已死；
// 本进程活跃任务有注册表守卫，绝不动活跃任务。
import { getDb } from '../db';
import { refundCredits } from '../credits';
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

function jobStillLive(jobId: string): boolean {
  if (!jobId) return false;
  if (activeJobs.has(jobId)) return true;
  const job = getGenDb()
    .prepare('SELECT status, updated_at FROM generation_jobs WHERE id = ?')
    .get(jobId) as { status: string; updated_at: number } | undefined;
  if (!job || !['queued', 'running'].includes(String(job.status))) return false;
  return Number(job.updated_at) >= nowMs() - getGenerationConfig().jobStaleMs;
}

/** 按 ledger 实扣金额补退款（幂等键 = 正常退款键，重复执行/已退过都不双退） */
function refundCharge(
  chargeKey: string,
  userId: string,
  reason: string,
  refType: string,
  refId: string,
): void {
  const refundKey = `${chargeKey}:refund`;
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
    console.error('[anppt-v2][recovery] refund failed:', chargeKey, error);
  }
}

/**
 * 收敛中断的整套生成（幂等，同步）。deck 状态被读取（getDeckState /
 * startDeckGeneration）时触发。返回是否修复了状态（调用方应重读 deck）。
 */
export function reconcileDeckGeneration(deck: DeckRow): boolean {
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
    if (live && (activeJobs.has(String(live.id)) || Number(live.updated_at) >= nowMs() - getGenerationConfig().jobStaleMs)) {
      return false;
    }
  }

  let healed = false;
  for (const slide of stuck) {
    const version = db
      .prepare('SELECT id, job_id, status FROM slide_versions WHERE slide_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(slide.slideId) as { id: string; job_id: string; status: string } | undefined;
    const jobId = String(version?.job_id || '');
    if (jobStillLive(jobId)) continue;
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
    if (jobId) {
      refundCharge(
        `deck-generate:${deck.id}:${jobId}:${slide.slideId}`,
        deck.userId,
        `第 ${slide.pageIndex + 1} 页生成中断退回`,
        'deck',
        deck.id,
      );
    }
    healed = true;
  }

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
  if (healed) console.warn(`[anppt-v2][recovery] deck ${deck.id} 收敛了中断的生成状态`);
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
    // 页卡 running 但没有在途 version（老数据）：直接置 failed
    db.prepare("UPDATE single_pages SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')").run(
      '生成中断（服务重启），请重试',
      nowMs(),
      pageId,
    );
    return true;
  }
  if (Number(version.updated_at) >= nowMs() - getGenerationConfig().jobStaleMs) return false;
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
  const chargeKey = String(version.charge_key || '');
  if (chargeKey) {
    refundCharge(chargeKey, String(page.user_id), '单页生成中断退回', 'single-page', pageId);
  }
  console.warn(`[anppt-v2][recovery] single page ${pageId} 收敛了中断状态`);
  return true;
}
