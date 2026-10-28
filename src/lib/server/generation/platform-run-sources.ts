// 整套与单页的运行源（平台两域）：只列本域在途行并给出幂等结算动作；
// 判活/退款/终态顺序归恢复入口与 paid-run，DSL 与状态机仍归 decks.ts / single-pages.ts。
import { getGenDb, nowMs } from './db';
import { deckChargeKey, singlePageChargeKey } from './charge-keys';
import { registerRunSources, type InterruptedRun, type RunSource, type RunSourceContext } from './run-source';

function jobStillLive(jobId: string, ctx: RunSourceContext): boolean {
  if (!jobId) return false;
  if (ctx.isInFlight(jobId)) return true;
  const job = getGenDb()
    .prepare('SELECT status, updated_at FROM generation_jobs WHERE id = ?')
    .get(jobId) as { status: string; updated_at: number } | undefined;
  if (!job || !['queued', 'running'].includes(String(job.status))) return false;
  return !ctx.isStale(Number(job.updated_at));
}

function deckRuns(userId: string, ctx: RunSourceContext): InterruptedRun[] {
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
    if (live && ctx.isLive(String(live.id), Number(live.updated_at))) protectedDecks.add(deckId);
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
      .prepare('SELECT id, job_id, status, charge_key FROM slide_versions WHERE slide_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(String(slide.slideId)) as { id: string; job_id: string; status: string; charge_key: string } | undefined;
    const jobId = String(version?.job_id || '');
    // 存储键优先（键形演进后老行仍对得上账）；迁移前无 charge_key 的老行回退键模块
    const storedChargeKey = String(version?.charge_key || '');
    runs.push({
      key: String(slide.slideId),
      domain: 'deck',
      userId: String(slide.userId),
      interrupted: !jobStillLive(jobId, ctx),
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
      chargeKey: storedChargeKey || (jobId ? deckChargeKey({ deckId, jobId, slideId: String(slide.slideId) }) : ''),
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

function singlePageRuns(userId: string, ctx: RunSourceContext): InterruptedRun[] {
  const db = getGenDb();
  const pages = db
    .prepare("SELECT id, user_id FROM single_pages WHERE user_id = ? AND status IN ('queued','running')")
    .all(userId) as Array<{ id: string; user_id: string }>;
  const runs: InterruptedRun[] = [];
  for (const page of pages) {
    const pageId = String(page.id);
    // 找最新的「在途」version（终态版本不算——页可能 running 而最新版本是历史成功版）
    const version = db
      .prepare("SELECT id, status, charge_key, job_id, updated_at FROM single_page_versions WHERE page_id = ? AND status IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(pageId) as { id: string; status: string; charge_key: string; job_id: string; updated_at: number } | undefined;
    // 在飞注册表归 paid-run，键 = 扣费键；迁移前无存储键的老行按键模块回退拼一次
    const jobId = String(version?.job_id || '');
    const liveKey = String(version?.charge_key || '') || (jobId ? singlePageChargeKey({ pageId, jobId }) : '');
    if (liveKey && ctx.isInFlight(liveKey)) continue;
    // 重放被拒的崩溃残留：该扣费键已被同页成功版本消费（同 requestId 的首笔已出图），
    // 恢复只补终态、不退款，否则会按旧键把成功那笔钱退掉。
    const consumedBy = liveKey
      ? (db
        .prepare("SELECT id FROM single_page_versions WHERE page_id = ? AND status = 'succeeded' AND charge_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(pageId, liveKey) as { id: string } | undefined)
      : undefined;
    const chargeKey = consumedBy ? '' : liveKey;
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
      interrupted: ctx.isStale(Number(version.updated_at)),
      settle: () => {
        db.prepare("UPDATE single_page_versions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
          '生成中断（服务重启），请重试',
          nowMs(),
          String(version.id),
        );
        if (consumedBy) {
          db.prepare("UPDATE single_pages SET status = 'succeeded', error = '', active_version_id = ?, updated_at = ? WHERE id = ?").run(
            String(consumedBy.id),
            nowMs(),
            pageId,
          );
          return;
        }
        db.prepare("UPDATE single_pages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
          '生成中断（服务重启），请重试',
          nowMs(),
          pageId,
        );
      },
      chargeKey,
      refundReason: '单页生成中断退回',
      refType: 'single-page',
      refId: pageId,
    });
  }
  return runs;
}

const deckRunSource: RunSource = { domain: 'deck', listRuns: deckRuns };
const singlePageRunSource: RunSource = { domain: 'single-page', listRuns: singlePageRuns };

/** 平台两源在装配期登记（模块源由顶层 src/recovery-assembly.ts 注入，平台不 import 模块）。 */
export function registerPlatformRunSources(): void {
  registerRunSources([deckRunSource, singlePageRunSource]);
}
