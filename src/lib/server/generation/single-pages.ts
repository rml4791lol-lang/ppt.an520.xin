// 单页生成器（创意页面生成器）：generate / refine / 导出图片版 PPTX。
// 与 deck 共用生图上游与扣费语义：每张 singlePageCredits（默认 10🌟），失败自动退还。
import { ApiError, validationError } from '../http';
import { debitCredits, refundCredits } from '../credits';
import { getGenerationConfig } from './config';
import { genId, getGenDb, nowMs } from './db';
import { markSinglePageActive, markSinglePageDone, reconcileSinglePage } from './recovery';
import { editImage, generateImage, toPublicImageError, type ImageDeps } from './images';
import { readSiteFile, saveFile } from './storage';
import { buildSlideImagePrompt, resolveStylePack } from './style-packs';
import { cleanString } from './types';

export interface SinglePageDeps extends ImageDeps {}

type Row = Record<string, string | number | null>;

export interface SinglePageRow {
  pageId: string;
  projectId: string;
  userId: string;
  pageIndex: number;
  title: string;
  content: string;
  stylePackId: string;
  status: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
  error: string;
  activeVersionId: string;
  createdAt: number;
  updatedAt: number;
}

function toPageRow(row: Row): SinglePageRow {
  return {
    pageId: String(row.id),
    projectId: String(row.project_id),
    userId: String(row.user_id),
    pageIndex: Number(row.page_index),
    title: String(row.title || ''),
    content: String(row.content || ''),
    stylePackId: String(row.style_pack_id || ''),
    status: String(row.status || 'idle') as SinglePageRow['status'],
    error: String(row.error || ''),
    activeVersionId: String(row.active_version_id || ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function cleanPageId(value: unknown): string {
  const id = cleanString(value, 80);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw validationError('pageId 不合法（仅字母数字-_）');
  return id;
}

export function getOwnedPage(userId: string, pageId: string): SinglePageRow {
  const row = getGenDb()
    .prepare('SELECT * FROM single_pages WHERE id = ? AND user_id = ?')
    .get(cleanPageId(pageId), userId) as Row | undefined;
  if (!row) throw new ApiError('PAGE_NOT_FOUND', '页面不存在', 404, false);
  return toPageRow(row);
}

function getOrCreateProject(userId: string, projectId: string | undefined, title?: string): string {
  const db = getGenDb();
  if (projectId) {
    const row = db
      .prepare('SELECT id FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(cleanString(projectId, 80), userId) as Row | undefined;
    if (!row) throw new ApiError('PROJECT_NOT_FOUND', '单页项目不存在', 404, false);
    return String(row.id);
  }
  const id = genId('spp');
  const ts = nowMs();
  db.prepare(
    `INSERT INTO single_page_projects (id, user_id, title, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, userId, cleanString(title, 120) || '未命名单页项目', ts, ts);
  return id;
}

function upsertPage(
  userId: string,
  input: { pageId: string; projectId?: string; title?: string; content: string; stylePackId?: string },
): SinglePageRow {
  const db = getGenDb();
  const existing = db.prepare('SELECT * FROM single_pages WHERE id = ? AND user_id = ?').get(input.pageId, userId) as
    | Row
    | undefined;
  const ts = nowMs();
  if (existing) {
    if (String(existing.status) === 'running' || String(existing.status) === 'queued') {
      throw new ApiError('GENERATION_RUNNING', '该页正在生成中，请稍候', 409, true);
    }
    db.prepare(
      `UPDATE single_pages SET title = ?, content = ?, style_pack_id = ?, updated_at = ? WHERE id = ?`,
    ).run(
      cleanString(input.title, 120) || String(existing.title || ''),
      input.content,
      cleanString(input.stylePackId, 80) || String(existing.style_pack_id || ''),
      ts,
      input.pageId,
    );
    return getOwnedPage(userId, input.pageId);
  }
  const projectId = getOrCreateProject(userId, input.projectId, input.title);
  const count = Number(db.prepare('SELECT COUNT(*) AS c FROM single_pages WHERE project_id = ?').get(projectId)?.c || 0);
  db.prepare(
    `INSERT INTO single_pages
      (id, project_id, user_id, page_index, title, content, style_pack_id, status, error, active_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', '', '', ?, ?)`,
  ).run(
    input.pageId,
    projectId,
    userId,
    count,
    cleanString(input.title, 120) || `Page ${count + 1}`,
    input.content,
    cleanString(input.stylePackId, 80),
    ts,
    ts,
  );
  return getOwnedPage(userId, input.pageId);
}

function buildPagePrompt(page: SinglePageRow, refineInstruction?: string): string {
  const pack = resolveStylePack(page.stylePackId);
  const base = buildSlideImagePrompt(
    {
      role: 'content',
      pageType: '',
      title: page.title,
      goal: '',
      copyLines: page.content.split(/\n+/).map((line) => line.trim()).filter(Boolean),
      visualNote: '',
    },
    pack,
  );
  if (!refineInstruction) return base;
  return `${base}\n\n改图要求（保持整体风格与版式）：${cleanString(refineInstruction, 1000)}`;
}

export interface SingleGenerateInput {
  pageId: string;
  projectId?: string;
  title?: string;
  content: string;
  stylePackId?: string;
  /** 原稿图（/api/assets/upload 返回的 path）：提供后走 i2i 重设计而非纯文生图 */
  imagePath?: string;
  /** 客户端幂等键（可选）；缺省用服务端 jobId */
  requestId?: string;
}

/** 校验原稿图路径归属当前用户（uploads/{userId}/...），返回规范化相对路径 */
function assertOwnedUpload(userId: string, imagePath: unknown): string {
  const rel = cleanString(imagePath, 300).replace(/^\/api\/files\//, '').replace(/^\/+/, '');
  const segments = rel.split('/').filter(Boolean);
  if (segments.length < 3 || segments[0] !== 'uploads' || segments[1] !== userId) {
    throw new ApiError('FILE_FORBIDDEN', '原稿图不存在或不属于当前账号', 403, false);
  }
  return rel;
}

export interface SingleRunResult {
  page: SinglePageRow;
  versionId: string;
  jobId: string;
  imageUrl: string;
  status: 'succeeded' | 'failed';
  error: string;
  balance: number;
}

async function runSinglePageJob(
  page: SinglePageRow,
  opts: { kind: 'single-generate' | 'single-refine'; refineInstruction?: string; sourceImagePath?: string; requestId?: string },
  deps: SinglePageDeps,
): Promise<SingleRunResult> {
  const config = deps.config ?? getGenerationConfig();
  const unitPrice = config.singlePageCredits;
  const jobId = genId('job');
  // 与 credits.cleanKey 同口径归一（trim 后截 128），保证存库的键 = 实际扣费键，崩溃恢复按它找孤儿扣费
  const chargeKey = `single-page:${page.pageId}:${opts.requestId || jobId}`.trim().slice(0, 128);
  const refundKey = `${chargeKey}:refund`;
  const prompt = buildPagePrompt(page, opts.refineInstruction);

  const versionId = genId('ver');
  const ts = nowMs();
  markSinglePageActive(page.pageId);
  try {
    getGenDb()
      .prepare(
        `INSERT INTO single_page_versions
          (id, page_id, kind, prompt, status, image_path, image_url, error, job_id, charge_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', '', '', '', ?, ?, ?, ?)`,
      )
      .run(versionId, page.pageId, opts.kind === 'single-refine' ? 'refine' : 'generate', prompt, jobId, chargeKey, ts, ts);
    getGenDb()
      .prepare('UPDATE single_pages SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .run('running', '', ts, page.pageId);

    let debit;
    try {
      debit = debitCredits(page.userId, unitPrice, {
        reason: opts.kind === 'single-refine' ? '单页改图' : '单页生成',
        idempotencyKey: chargeKey,
        refType: 'single-page',
        refId: page.pageId,
      });
    } catch (error) {
      getGenDb().prepare("UPDATE single_page_versions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
        'INSUFFICIENT_CREDITS',
        nowMs(),
        versionId,
      );
      getGenDb().prepare("UPDATE single_pages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
        'INSUFFICIENT_CREDITS: 🌟 星星不足，请充值后重试',
        nowMs(),
        page.pageId,
      );
      throw error;
    }

    const finish = (status: 'succeeded' | 'failed', imagePath: string, imageUrl: string, errorText: string) => {
      getGenDb()
        .prepare('UPDATE single_page_versions SET status = ?, image_path = ?, image_url = ?, error = ?, updated_at = ? WHERE id = ?')
        .run(status, imagePath, imageUrl, errorText, nowMs(), versionId);
      getGenDb()
        .prepare('UPDATE single_pages SET status = ?, error = ?, active_version_id = ?, updated_at = ? WHERE id = ?')
        .run(status, errorText, status === 'succeeded' ? versionId : page.activeVersionId, nowMs(), page.pageId);
    };

    try {
      let image: Buffer;
      if (opts.kind === 'single-refine') {
        const current = page.activeVersionId
          ? getGenDb().prepare('SELECT image_path FROM single_page_versions WHERE id = ?').get(page.activeVersionId)
          : null;
        const source = current ? await readSiteFile(String(current.image_path || ''), config) : null;
        if (!source) throw new Error('原图不存在，无法改图');
        image = await editImage({ image: source, instruction: opts.refineInstruction || '' }, deps);
      } else if (opts.sourceImagePath) {
        // i2i 原稿重设计：以上传图为底，按风格化 prompt 全面重绘
        const source = await readSiteFile(opts.sourceImagePath, config);
        if (!source) throw new Error('原稿图不存在或已过期，请重新上传');
        image = await editImage(
          { image: source, instruction: `${prompt}\n\n参考上传的原稿图：保留其核心信息、层级与大致版式，按以上需求全面重新设计为精致的一页 16:9 演示页。` },
          deps,
        );
      } else {
        image = await generateImage({ prompt }, deps);
      }
      const saved = await saveFile('generated', page.userId, image, { kind: 'single', ext: '.png', id: versionId }, config);
      finish('succeeded', saved.relPath, saved.url, '');
      return {
        page: getOwnedPage(page.userId, page.pageId),
        versionId,
        jobId,
        imageUrl: saved.url,
        status: 'succeeded',
        error: '',
        balance: debit.balance,
      };
    } catch (error) {
      const publicError = toPublicImageError(error);
      const errorText = `${publicError.code}: ${publicError.message}`;
      finish('failed', '', '', errorText);
      try {
        refundCredits(page.userId, unitPrice, {
          reason: '单页生成失败退回',
          idempotencyKey: refundKey,
          refType: 'single-page',
          refId: page.pageId,
        });
      } catch (refundError) {
        console.error('[anppt-v2][single-page] refund failed:', refundError);
      }
      return {
        page: getOwnedPage(page.userId, page.pageId),
        versionId,
        jobId,
        imageUrl: '',
        status: 'failed',
        error: errorText,
        balance: debit.balance,
      };
    }
  } finally {
    markSinglePageDone(page.pageId);
  }
}

export async function generateSinglePage(
  userId: string,
  input: SingleGenerateInput,
  deps: SinglePageDeps = {},
): Promise<SingleRunResult> {
  const content = cleanString(input.content, 8000);
  if (!content) throw validationError('页面内容不能为空');
  // 先收敛历史中断（否则卡 running 的页会永远 409），upsertPage 内部再做运行中检查
  reconcileSinglePage(userId, cleanPageId(input.pageId));
  const page = upsertPage(userId, { ...input, pageId: cleanPageId(input.pageId), content });
  const sourceImagePath = input.imagePath ? assertOwnedUpload(userId, input.imagePath) : undefined;
  return runSinglePageJob(page, { kind: 'single-generate', sourceImagePath, requestId: input.requestId }, deps);
}

export async function refineSinglePage(
  userId: string,
  input: { pageId: string; editInstruction: string; requestId?: string },
  deps: SinglePageDeps = {},
): Promise<SingleRunResult> {
  reconcileSinglePage(userId, cleanPageId(input.pageId));
  const page = getOwnedPage(userId, input.pageId);
  const editInstruction = cleanString(input.editInstruction, 1000);
  if (!editInstruction) throw validationError('缺少 editInstruction');
  if (page.status !== 'succeeded' || !page.activeVersionId) {
    throw new ApiError('REFINE_NEEDS_IMAGE', '该页还没有生成图，无法改图', 409, false);
  }
  return runSinglePageJob(page, { kind: 'single-refine', refineInstruction: editInstruction, requestId: input.requestId }, deps);
}

export function listSingleProjectPages(userId: string, projectId: string): SinglePageRow[] {
  const db = getGenDb();
  const project = db
    .prepare('SELECT id FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(cleanString(projectId, 80), userId) as Row | undefined;
  if (!project) throw new ApiError('PROJECT_NOT_FOUND', '单页项目不存在', 404, false);
  const rows = db
    .prepare('SELECT * FROM single_pages WHERE project_id = ? ORDER BY page_index ASC')
    .all(String(project.id)) as Row[];
  return rows.map(toPageRow);
}

export function getActiveVersionImagePath(page: SinglePageRow): string {
  if (!page.activeVersionId) return '';
  const row = getGenDb()
    .prepare('SELECT image_path FROM single_page_versions WHERE id = ?')
    .get(page.activeVersionId) as Row | undefined;
  return String(row?.image_path || '');
}

// ---------- 项目详情 / 版本 ----------

export interface SinglePageVersionView {
  versionId: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  imageUrl: string;
  error: string;
  createdAt: number;
}

export function listPageVersions(pageId: string): SinglePageVersionView[] {
  const rows = getGenDb()
    .prepare('SELECT * FROM single_page_versions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(pageId) as Row[];
  return rows.map((row) => ({
    versionId: String(row.id),
    kind: String(row.kind || 'generate'),
    status: String(row.status || 'queued') as SinglePageVersionView['status'],
    imageUrl: String(row.image_url || ''),
    error: String(row.error || ''),
    createdAt: Number(row.created_at),
  }));
}

/** 单页项目详情（?projectId= 恢复历史页 + 版本列表）；读取时顺带懒恢复中断页 */
export function getSingleProjectDetail(userId: string, projectId: string) {
  const db = getGenDb();
  const project = db
    .prepare('SELECT * FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(cleanString(projectId, 80), userId) as Row | undefined;
  if (!project) throw new ApiError('PROJECT_NOT_FOUND', '单页项目不存在', 404, false);
  for (const page of listSingleProjectPages(userId, String(project.id))) {
    reconcileSinglePage(userId, page.pageId);
  }
  const pages = listSingleProjectPages(userId, String(project.id)).map((page) => ({
    ...page,
    versions: listPageVersions(page.pageId),
  }));
  return {
    project: {
      id: String(project.id),
      title: String(project.title || ''),
      createdAt: Number(project.created_at),
      updatedAt: Number(project.updated_at),
    },
    pages,
  };
}

/** 版本回退/选择：仅允许切到生成成功的版本 */
export function selectSinglePageVersion(userId: string, pageId: string, versionId: string): SinglePageRow {
  const page = getOwnedPage(userId, pageId);
  if (page.status === 'running' || page.status === 'queued') {
    throw new ApiError('GENERATION_RUNNING', '该页正在生成中，请稍候', 409, true);
  }
  const row = getGenDb()
    .prepare('SELECT id, status FROM single_page_versions WHERE id = ? AND page_id = ?')
    .get(cleanString(versionId, 80), page.pageId) as Row | undefined;
  if (!row) throw new ApiError('VERSION_NOT_FOUND', '版本不存在', 404, false);
  if (String(row.status) !== 'succeeded') {
    throw new ApiError('VERSION_NOT_READY', '只能切换到生成成功的版本', 409, false);
  }
  getGenDb()
    .prepare("UPDATE single_pages SET active_version_id = ?, status = 'succeeded', error = '', updated_at = ? WHERE id = ?")
    .run(String(row.id), nowMs(), page.pageId);
  return getOwnedPage(userId, page.pageId);
}
