// 生成链崩溃恢复（懒触发）。
// 背景：deploy 重启/进程崩溃会打断在途生成——deck 卡 generating（409 死锁）、
// 页面卡 queued/running（不在默认重生成范围）、已扣费页没有退款（退款逻辑在
// 内存 catch 里，进程死了不执行）。收敛放在带身份的请求入口（requireUser），
// 读/写路径只表达业务，不必各自记得恢复。
// 判定依据：job 心跳（每页完成时更新 updated_at）超时或已终态 = 进程已死；
// 本进程活跃任务有注册表守卫，绝不动活跃任务。
import { getDb } from '../db';
import { deriveRefundKey, refundCredits } from '../credits';
import { logProblem } from '../problem-log';
import { interruptedPptToBaseRuns } from '@/modules/ppt-to-base/server/recovery';
import { getGenDb, nowMs } from './db';
import { getGenerationConfig } from './config';

// ---- 本进程活跃任务注册表（generate.ts / single-pages.ts / ppt-to-base 注册） ----

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
 * 调用方只负责列出在途任务；重复调用幂等。
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
 * 调用方已判定中断的单条任务：收敛 + 按实扣金额补退。
 * 判活留在调用方（读路径无法等心跳扫描），不必为了签名伪造 interrupted 标志。
 */
export function reconcileInterruptedRun(run: Omit<InterruptedRun, 'interrupted'>): number {
  return reconcileInterrupted([{ ...run, interrupted: true }]);
}

/**
 * 唯一恢复入口：收敛该用户全部生成类型的在途任务，返回收敛条数。
 * 由 requireUser 在鉴权门调用——新增读/写路径只要走这道门，就不用再接恢复；
 * 判活、收敛与补退口径都收在本模块，生成类型不再各写一套。
 */
export function reconcileUser(userId: string): number {
  return reconcileInterrupted([...deckRuns(userId), ...singlePageRuns(userId), ...pptToBaseRuns(userId)]);
}

function deckRuns(userId: string): InterruptedRun[] {
  const db = getGenDb();
  const generating = db
    .prepare("SELECT id FROM decks WHERE user_id = ? AND status = 'generating'")
    .all(userId) as Array<{ id: string }>;
  // 整批在途守卫：job 活跃时该 deck 的 queued/running 页全部归属它——其 slide_versions
  // 行要等蓝图/生图调度后才逐页落库，此刻收敛会误杀在途页并按旧版本误退原始扣费。
  const protectedDecks = new Set<string>();
  for (const row of generating) {
    const deckId = String(row.id);
    const live = db
      .prepare("SELECT id, updated_at FROM generation_jobs WHERE deck_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
      .get(deckId) as { id: string; updated_at: number } | undefined;
    if (live && (activeJobs.has(String(live.id)) || !isStale(Number(live.updated_at)))) protectedDecks.add(deckId);
  }

  const stuck = db
    .prepare(
      `SELECT s.id AS slideId, s.page_index AS pageIndex, s.deck_id AS deckId, d.user_id AS userId
       FROM deck_slides s JOIN decks d ON d.id = s.deck_id
       WHERE d.user_id = ? AND s.gen_status IN ('queued','running')`,
    )
    .all(userId) as Array<{ slideId: string; pageIndex: number; deckId: string; userId: string }>;

  const runs: InterruptedRun[] = [];
  for (const slide of stuck) {
    const deckId = String(slide.deckId);
    if (protectedDecks.has(deckId)) continue;
    const version = db
      .prepare('SELECT id, job_id, status FROM slide_versions WHERE slide_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(String(slide.slideId)) as { id: string; job_id: string; status: string } | undefined;
    const jobId = String(version?.job_id || '');
    runs.push({
      key: String(slide.slideId),
      domain: 'deck',
      userId: String(slide.userId),
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
          String(slide.slideId),
        );
      },
      chargeKey: jobId ? `deck-generate:${deckId}:${jobId}:${slide.slideId}` : '',
      refundReason: `第 ${Number(slide.pageIndex) + 1} 页生成中断退回`,
      refType: 'deck',
      refId: deckId,
    });
  }
  for (const row of generating) {
    const deckId = String(row.id);
    if (protectedDecks.has(deckId)) continue;
    // 活跃 job 已在上方守卫排除；走到这里必是死 job，deck 卡 generating 会永久 409
    runs.push({
      key: deckId,
      domain: 'deck',
      userId,
      interrupted: true,
      settle: () => {
        db.prepare(
          "UPDATE generation_jobs SET status = 'failed', error = ?, updated_at = ? WHERE deck_id = ? AND status IN ('queued','running')",
        ).run('生成中断（服务重启），已自动恢复为可重试', nowMs(), deckId);
        const anySucceeded = db
          .prepare("SELECT 1 FROM deck_slides WHERE deck_id = ? AND gen_status IN ('succeeded','stale') LIMIT 1")
          .get(deckId);
        db.prepare('UPDATE decks SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
          anySucceeded ? 'partial' : 'confirmed',
          '',
          nowMs(),
          deckId,
        );
      },
      refType: 'deck',
      refId: deckId,
    });
  }
  return runs;
}

function singlePageRuns(userId: string): InterruptedRun[] {
  const db = getGenDb();
  const pages = db
    .prepare("SELECT id, user_id FROM single_pages WHERE user_id = ? AND status IN ('queued','running')")
    .all(userId) as Array<{ id: string; user_id: string }>;
  const runs: InterruptedRun[] = [];
  for (const page of pages) {
    const pageId = String(page.id);
    if (activeSinglePages.has(pageId)) continue;
    // 找最新的「在途」version（终态版本不算——页可能 running 而最新版本是历史成功版）
    const version = db
      .prepare("SELECT id, status, charge_key, updated_at FROM single_page_versions WHERE page_id = ? AND status IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(pageId) as { id: string; status: string; charge_key: string; updated_at: number } | undefined;
    if (!version) {
      // 页卡在途但没有在途 version（老数据）：没有版本就没有扣费键可退，直接置 failed
      runs.push({
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
      });
      continue;
    }
    runs.push({
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
    });
  }
  return runs;
}

function pptToBaseRuns(userId: string): InterruptedRun[] {
  // 底座表归模块：这里只注入判活口径，调度模块导出的结算入口
  return interruptedPptToBaseRuns(userId, (jobId, heartbeatMs) => activeJobs.has(jobId) || !isStale(heartbeatMs));
}
