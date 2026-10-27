// PPT 美化批量任务：浏览器只负责启动与轮询，失败/刷新不再中断后续页面。
import { ApiError, validationError } from '@/lib/server/http';
import { getGenerationConfig } from '@/lib/server/generation/config';
import { genId, getGenDb, nowMs } from '@/lib/server/generation/db';
import {
  getOwnedPage,
  listSingleProjectPageStatuses,
  type SinglePageDeps,
  type SinglePageStatusView,
} from '@/lib/server/generation/single-pages';
import { cleanString } from '@/lib/server/generation/types';
import { logProblem } from '@/lib/server/problem-log';
import { generateReplicatePage } from './pages';
import {
  parseIncomingStructure,
  resolveReplicateColorMode,
  type ReplicateColorMode,
} from './replicate';

export type SinglePageBatchStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

export interface SinglePageBatchRow {
  batchId: string;
  userId: string;
  projectId: string;
  status: SinglePageBatchStatus;
  total: number;
  succeeded: number;
  failed: number;
  error: string;
  targetIds: string[];
  startVersions: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt: number;
  reused?: boolean;
}

export interface SinglePageBatchDetail {
  batch: SinglePageBatchRow | null;
  pages: SinglePageStatusView[];
}

type Row = Record<string, string | number | null>;

const BATCH_CONCURRENCY = 3;
const MAX_BATCH_PAGES = 40;
function toBatchRow(row: Row): SinglePageBatchRow {
  let targetIds: string[] = [];
  let startVersions: Record<string, string> = {};
  try {
    const parsed = JSON.parse(String(row.target_ids || '[]')) as unknown;
    if (Array.isArray(parsed)) targetIds = parsed.map(String).filter(Boolean);
  } catch {
    targetIds = [];
  }
  try {
    const parsed = JSON.parse(String(row.start_versions || '{}')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      startVersions = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .map(([key, value]) => [key, String(value || '')])
          .filter(([key]) => Boolean(key)),
      );
    }
  } catch {
    startVersions = {};
  }
  return {
    batchId: String(row.id),
    userId: String(row.user_id),
    projectId: String(row.project_id),
    status: String(row.status || 'queued') as SinglePageBatchStatus,
    total: Number(row.total) || 0,
    succeeded: Number(row.succeeded) || 0,
    failed: Number(row.failed) || 0,
    error: String(row.error || ''),
    targetIds,
    startVersions,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    startedAt: Number(row.started_at) || 0,
    completedAt: Number(row.completed_at) || 0,
  };
}

function findReplicateProject(userId: string, projectId: string): Row {
  const row = getGenDb()
    .prepare('SELECT * FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(cleanString(projectId, 80), userId) as Row | undefined;
  if (!row) throw new ApiError('PROJECT_NOT_FOUND', '单页项目不存在', 404, false);
  if (String(row.source || '') !== 'replicate') {
    throw new ApiError('REPLICATE_PROJECT_REQUIRED', '该批量任务只支持 PPT 美化项目', 409, false);
  }
  return row;
}

export function latestBatch(userId: string, projectId: string): SinglePageBatchRow | null {
  const row = getGenDb()
    .prepare(
      `SELECT * FROM single_page_batches
       WHERE user_id = ? AND project_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(userId, projectId) as Row | undefined;
  return row ? toBatchRow(row) : null;
}

function activeBatch(userId: string, projectId: string): SinglePageBatchRow | null {
  const row = getGenDb()
    .prepare(
      `SELECT * FROM single_page_batches
       WHERE user_id = ? AND project_id = ? AND status IN ('queued', 'running')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(userId, projectId) as Row | undefined;
  return row ? toBatchRow(row) : null;
}

function updateBatchProgress(batchId: string, succeeded: number, failed: number): void {
  getGenDb()
    .prepare('UPDATE single_page_batches SET succeeded = ?, failed = ?, updated_at = ? WHERE id = ?')
    .run(succeeded, failed, nowMs(), batchId);
}

function finishBatch(
  batchId: string,
  status: SinglePageBatchStatus,
  succeeded: number,
  failed: number,
  error: string,
): void {
  const ts = nowMs();
  getGenDb()
    .prepare(
      `UPDATE single_page_batches
       SET status = ?, succeeded = ?, failed = ?, error = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`,
    )
    .run(status, succeeded, failed, error, ts, ts, batchId);
}

function targetPageIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw validationError('pageIds 必须是数组');
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of raw) {
    const id = cleanString(item, 80);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw validationError('pageId 不合法');
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) throw validationError('没有需要生成的页面');
  if (ids.length > MAX_BATCH_PAGES) throw validationError(`一次最多生成 ${MAX_BATCH_PAGES} 页`);
  return ids;
}

async function runBatch(
  userId: string,
  projectId: string,
  batchId: string,
  startVersionIds: Map<string, string>,
  pages: ReturnType<typeof getOwnedPage>[],
  colorMode: ReplicateColorMode,
  structures: Record<string, unknown>,
  deps: SinglePageDeps,
): Promise<void> {
  let cursor = 0;
  let succeeded = 0;
  let failed = 0;
  let stopForCredits = false;
  let creditsMessage = '';

  const worker = async () => {
    while (cursor < pages.length && !stopForCredits) {
      const target = pages[cursor];
      cursor += 1;
      try {
        const current = getOwnedPage(userId, target.pageId);
        // 另一个标签页/客户端可能已完成该页；批量任务不再重复扣费。
        const existingVersion = startVersionIds.get(current.pageId) || '';
        if (current.status === 'succeeded' && current.activeVersionId && current.activeVersionId !== existingVersion) {
          succeeded += 1;
        } else {
          const hasStructure = Object.prototype.hasOwnProperty.call(structures, current.pageId);
          const result = await generateReplicatePage(
            userId,
            {
              pageId: current.pageId,
              projectId,
              title: current.title,
              content: current.content,
              stylePackId: current.stylePackId || undefined,
              imagePath: current.shellPath,
              colorMode,
              requestId: `${batchId}:${current.pageId}`,
              structureProvided: hasStructure,
              structure: hasStructure ? parseIncomingStructure(structures[current.pageId]) : null,
            },
            deps,
          );
          if (result.status === 'succeeded') succeeded += 1;
          else failed += 1;
        }
      } catch (error) {
        failed += 1;
        if (error instanceof ApiError && error.code === 'INSUFFICIENT_CREDITS') {
          stopForCredits = true;
          creditsMessage = error.message;
        }
      } finally {
        updateBatchProgress(batchId, succeeded, failed);
      }
    }
  };

  try {
    const workers = Array.from(
      { length: Math.min(BATCH_CONCURRENCY, pages.length) },
      () => worker(),
    );
    await Promise.all(workers);
    const remaining = pages.length - succeeded - failed;
    const status: SinglePageBatchStatus = stopForCredits
      ? succeeded > 0 ? 'partial' : 'failed'
      : failed > 0 ? succeeded > 0 ? 'partial' : 'failed' : 'succeeded';
    const error = stopForCredits
      ? `${creditsMessage || '星星不足'} 已完成 ${succeeded} 页，剩余 ${remaining} 页未生成。`
      : failed > 0
        ? `${failed} 页生成失败，已自动退回星星；可重试失败页。`
        : '';
    finishBatch(batchId, status, succeeded, failed, error);
  } catch (error) {
    logProblem({
      category: 'generation',
      level: 'error',
      message: 'PPT 美化批量任务异常中断',
      detail: error,
      userId,
      refType: 'single-page-batch',
      refId: batchId,
    });
    finishBatch(batchId, 'failed', succeeded, Math.max(failed, pages.length - succeeded), '批量任务异常中断，请重试未完成页');
  }
}

/** 启动或复用当前项目的批量任务；worker 不阻塞 HTTP 响应。 */
export async function startReplicateBatch(
  userId: string,
  input: {
    projectId: unknown;
    pageIds: unknown;
    colorMode?: unknown;
    structures?: unknown;
  },
  deps: SinglePageDeps = {},
): Promise<SinglePageBatchRow> {
  const projectId = cleanString(input.projectId, 80);
  if (!projectId) throw validationError('缺少 projectId');
  findReplicateProject(userId, projectId);

  const existing = activeBatch(userId, projectId);
  if (existing) {
    const stale = existing.updatedAt < nowMs() - getGenerationConfig().jobStaleMs;
    if (!stale) return { ...existing, reused: true };
    // 崩溃遗留的 active 行不能永久堵住新任务；读取详情会收敛页状态并释放唯一索引。
    getSinglePageBatchDetail(userId, projectId);
    const refreshed = activeBatch(userId, projectId);
    if (refreshed) return { ...refreshed, reused: true };
  }

  const ids = targetPageIds(input.pageIds);
  const pages = ids.map((id) => {
    const page = getOwnedPage(userId, id);
    if (page.projectId !== projectId) throw new ApiError('PAGE_NOT_FOUND', '页面不属于该项目', 404, false);
    if (page.status === 'running' || page.status === 'queued') {
      throw new ApiError('GENERATION_RUNNING', `第 ${page.pageIndex + 1} 页正在生成中`, 409, true);
    }
    if (!page.content.trim()) throw validationError(`第 ${page.pageIndex + 1} 页没有文案`);
    if (!page.shellPath) throw validationError(`第 ${page.pageIndex + 1} 页缺少参考稿`);
    return page;
  });
  const colorMode = resolveReplicateColorMode(input.colorMode);
  const structures = input.structures && typeof input.structures === 'object' && !Array.isArray(input.structures)
    ? input.structures as Record<string, unknown>
    : {};

  const batchId = genId('spb');
  const ts = nowMs();
  const startVersions = Object.fromEntries(pages.map((page) => [page.pageId, page.activeVersionId]));
  try {
    getGenDb()
      .prepare(
        `INSERT INTO single_page_batches
          (id, user_id, project_id, status, total, succeeded, failed, error, target_ids, start_versions, created_at, updated_at, started_at, completed_at)
         VALUES (?, ?, ?, 'queued', ?, 0, 0, '', ?, ?, ?, ?, 0, 0)`,
      )
      .run(batchId, userId, projectId, pages.length, JSON.stringify(ids), JSON.stringify(startVersions), ts, ts);
  } catch {
    const raced = activeBatch(userId, projectId);
    if (raced) return { ...raced, reused: true };
    throw new ApiError('BATCH_START_FAILED', '批量任务启动失败，请重试', 500, true);
  }

  const startedAt = nowMs();
  getGenDb()
    .prepare("UPDATE single_page_batches SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?")
    .run(startedAt, startedAt, batchId);
  const batch = latestBatch(userId, projectId);
  if (!batch) throw new ApiError('BATCH_START_FAILED', '批量任务启动失败，请重试', 500, true);

  void runBatch(userId, projectId, batchId, new Map(Object.entries(startVersions)), pages, colorMode, structures, deps);
  return { ...batch, reused: false };
}

/** 读取项目最新批量任务（重启遗留的 running 页由鉴权门统一收敛）。 */
export function getSinglePageBatchDetail(userId: string, projectId: string): SinglePageBatchDetail {
  const cleanProjectId = cleanString(projectId, 80);
  if (!cleanProjectId) throw validationError('缺少 projectId');
  findReplicateProject(userId, cleanProjectId);
  const pages = listSingleProjectPageStatuses(userId, cleanProjectId);
  const batch = latestBatch(userId, cleanProjectId);
  if (!batch) return { batch: null, pages };

  if (batch.status === 'queued' || batch.status === 'running') {
    const targets = new Set(batch.targetIds);
    const targetPages = pages.filter((page) => targets.has(page.pageId));
    const running = targetPages.filter((page) => page.status === 'queued' || page.status === 'running').length;
    const succeeded = targetPages.filter((page) => {
      const startVersion = batch.startVersions[page.pageId] || '';
      return page.status === 'succeeded' && Boolean(page.imageUrl) && page.activeVersionId !== startVersion;
    }).length;
    const failed = targetPages.filter(
      (page) => page.status === 'failed' && page.updatedAt >= batch.startedAt,
    ).length;
    const stale = batch.updatedAt < nowMs() - getGenerationConfig().jobStaleMs;
    if (stale && running === 0) {
      const processed = succeeded + failed;
      const status: SinglePageBatchStatus = succeeded >= batch.total
        ? 'succeeded'
        : processed > 0
          ? 'partial'
          : 'failed';
      const error = status === 'succeeded'
        ? ''
        : `批量任务在服务重启后中断：已完成 ${succeeded}/${batch.total} 页，${Math.max(0, batch.total - processed)} 页未完成，可重新生成。`;
      finishBatch(batch.batchId, status, succeeded, Math.max(0, batch.total - succeeded), error);
      const finished = latestBatch(userId, cleanProjectId) ?? batch;
      return { batch: finished, pages };
    }
    return {
      batch: {
        ...batch,
        succeeded: Math.max(batch.succeeded, succeeded),
        failed: Math.max(batch.failed, failed),
      },
      pages,
    };
  }
  return { batch, pages };
}
