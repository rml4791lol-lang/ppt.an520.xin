// 单页生成器（创意页面生成器）：generate / refine / 导出图片版 PPTX。
// 与 deck 共用生图上游与扣费语义：每张 singlePageCredits（默认 10🌟），失败自动退还。
import { ApiError, validationError } from '../http';
import { withTransaction } from '../db';
import { chargeRefundKeys, debitCredits, refundCredits } from '../credits';
import { logProblem } from '../problem-log';
import { findUserById } from '../auth';
import { assertFeatureVisible } from '../feature-flags';
import { getGenerationConfig } from './config';
import { genId, getGenDb, nowMs } from './db';
import { markSinglePageActive, markSinglePageDone, reconcileSinglePage } from './recovery';
import { editImage, generateImage, toPublicImageError, type ImageDeps } from './images';
import { parseOwnedUploadRelPath, readSiteFile, saveFile } from './storage';
import {
  buildSlideImagePrompt,
  loadStyleReferenceDataUrl,
  resolveStylePack,
  selectStyleReferencePath,
  type SlidePromptInput,
} from './style-packs';
import { cleanString } from './types';
import {
  buildReplicateCopyPrompt,
  buildReplicateInstruction,
  parseIncomingStructure,
  resolveReplicateColorMode,
  type ReplicateColorMode,
  type SlideStructureCard,
} from '@/modules/ppt-replicate/server/replicate';

export type SinglePageDeps = ImageDeps;

type Row = Record<string, string | number | null>;

export interface SinglePageRow {
  pageId: string;
  projectId: string;
  userId: string;
  pageIndex: number;
  title: string;
  content: string;
  stylePackId: string;
  shellPath: string;
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
    shellPath: String(row.shell_path || ''),
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

export type SingleProjectSource = 'single' | 'replicate';

function resolveProjectSource(value: unknown): SingleProjectSource {
  return cleanString(value, 20) === 'replicate' ? 'replicate' : 'single';
}

function readProjectSource(userId: string, projectId: string): SingleProjectSource {
  const row = getGenDb()
    .prepare('SELECT source FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(cleanString(projectId, 80), userId) as Row | undefined;
  if (!row) throw new ApiError('PROJECT_NOT_FOUND', '单页项目不存在', 404, false);
  return resolveProjectSource(row.source);
}

function getOrCreateProject(
  userId: string,
  projectId: string | undefined,
  title: string | undefined,
  source: SingleProjectSource,
): string {
  const db = getGenDb();
  if (projectId) {
    const row = db
      .prepare('SELECT id, source FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(cleanString(projectId, 80), userId) as Row | undefined;
    if (!row) throw new ApiError('PROJECT_NOT_FOUND', '单页项目不存在', 404, false);
    const id = String(row.id);
    if (source === 'replicate' && resolveProjectSource(row.source) !== 'replicate') {
      db.prepare('UPDATE single_page_projects SET source = ?, updated_at = ? WHERE id = ?').run('replicate', nowMs(), id);
    }
    return id;
  }
  const id = genId('spp');
  const ts = nowMs();
  db.prepare(
    `INSERT INTO single_page_projects (id, user_id, title, source, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, userId, cleanString(title, 120) || '未命名单页项目', source, ts, ts);
  return id;
}

function upsertPage(
  userId: string,
  input: {
    pageId: string;
    projectId?: string;
    title?: string;
    content: string;
    stylePackId?: string;
    projectSource: SingleProjectSource;
    shellPath?: string;
  },
): SinglePageRow {
  const db = getGenDb();
  const existing = db.prepare('SELECT * FROM single_pages WHERE id = ? AND user_id = ?').get(input.pageId, userId) as
    | Row
    | undefined;
  const ts = nowMs();
  if (existing) {
    if (input.projectId && String(existing.project_id) !== cleanString(input.projectId, 80)) {
      throw new ApiError('PAGE_NOT_FOUND', '页面不属于该项目', 404, false);
    }
    if (String(existing.status) === 'running' || String(existing.status) === 'queued') {
      throw new ApiError('GENERATION_RUNNING', '该页正在生成中，请稍候', 409, true);
    }
    const nextTitle = cleanString(input.title, 120) || String(existing.title || '');
    const nextStylePackId = cleanString(input.stylePackId, 80) || String(existing.style_pack_id || '');
    const nextShellPath = cleanString(input.shellPath, 300) || String(existing.shell_path || '');
    const changed =
      input.content !== String(existing.content || '') ||
      nextTitle !== String(existing.title || '') ||
      nextStylePackId !== String(existing.style_pack_id || '') ||
      nextShellPath !== String(existing.shell_path || '');
    const invalidate = changed && String(existing.status || 'idle') === 'succeeded';
    db.prepare(
      `UPDATE single_pages
       SET title = ?, content = ?, style_pack_id = ?, shell_path = ?, status = ?, error = ?, active_version_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      nextTitle,
      input.content,
      nextStylePackId,
      nextShellPath,
      invalidate ? 'idle' : String(existing.status || 'idle'),
      invalidate ? '文案已更新，需重新生成' : String(existing.error || ''),
      invalidate ? '' : String(existing.active_version_id || ''),
      ts,
      input.pageId,
    );
    return getOwnedPage(userId, input.pageId);
  }
  const projectId = getOrCreateProject(userId, input.projectId, input.title, input.projectSource);
  const count = Number(db.prepare('SELECT COUNT(*) AS c FROM single_pages WHERE project_id = ?').get(projectId)?.c || 0);
  db.prepare(
    `INSERT INTO single_pages
      (id, project_id, user_id, page_index, title, content, style_pack_id, shell_path, status, error, active_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', '', '', ?, ?)`,
  ).run(
    input.pageId,
    projectId,
    userId,
    count,
    cleanString(input.title, 120) || `Page ${count + 1}`,
    input.content,
    cleanString(input.stylePackId, 80),
    cleanString(input.shellPath, 300),
    ts,
    ts,
  );
  return getOwnedPage(userId, input.pageId);
}

/** PPT 美化草稿：只保存项目/页面/参考稿路径，不生成、不扣星。 */
export function saveReplicateDraft(
  userId: string,
  input: {
    projectId?: string;
    title?: string;
    pages: Array<{
      pageId?: string;
      title?: string;
      content?: string;
      imagePath?: string;
    }>;
  },
): { projectId: string; pageCount: number } {
  const rawPages = Array.isArray(input.pages) ? input.pages : [];
  if (rawPages.length === 0) throw validationError('草稿至少要有 1 页');
  if (rawPages.length > 40) throw new ApiError('TOO_MANY_PAGES', '一次最多保存 40 页', 400, false);
  const title = cleanString(input.title, 120) || 'PPT 美化';
  const db = getGenDb();
  return withTransaction(db, () => {
    const projectId = getOrCreateProject(userId, input.projectId, title, 'replicate');
    db.prepare('UPDATE single_page_projects SET title = ?, source = ?, updated_at = ? WHERE id = ?').run(
      title,
      'replicate',
      nowMs(),
      projectId,
    );
    const pages = rawPages.map((page, index) => {
      const pageId = cleanString(page.pageId, 80) || genId('spp_page');
      const imagePath = page.imagePath
        ? parseOwnedUploadRelPath(userId, page.imagePath)
        : null;
      if (page.imagePath && !imagePath) {
        throw new ApiError('INVALID_IMAGE_PATH', `第 ${index + 1} 页参考稿路径无效`, 400, false);
      }
      return {
        pageId,
        title: cleanString(page.title, 120) || `第 ${index + 1} 页`,
        content: cleanString(page.content, 8000),
        imagePath: imagePath || '',
      };
    });
    for (const page of pages) {
      upsertPage(userId, {
        pageId: page.pageId,
        projectId,
        title: page.title,
        content: page.content,
        projectSource: 'replicate',
        shellPath: page.imagePath,
      });
    }
    return { projectId, pageCount: pages.length };
  });
}

function buildPagePrompt(
  page: SinglePageRow,
  refineInstruction?: string,
): { prompt: string; referencePath: string | null } {
  const pack = resolveStylePack(page.stylePackId);
  const slideInput: SlidePromptInput = {
    role: 'content',
    pageType: '',
    title: page.title,
    goal: '',
    copyLines: page.content.split(/\n+/).map((line) => line.trim()).filter(Boolean),
    visualNote: '',
  };
  const deckContext = { totalPages: 1, pageIndex: page.pageIndex, chapter: '' };
  const referencePath = selectStyleReferencePath(slideInput, pack, deckContext);
  const base = buildSlideImagePrompt(slideInput, pack, {
    withStyleReferenceHint: Boolean(referencePath),
    deckContext,
  });
  return {
    prompt: refineInstruction
      ? `${base}

改图要求（保持整体风格与版式）：${cleanString(refineInstruction, 1000)}`
      : base,
    referencePath,
  };
}

export interface SingleGenerateInput {
  pageId: string;
  projectId?: string;
  title?: string;
  content: string;
  stylePackId?: string;
  /** 原稿图（/api/assets/upload 返回的 path）：提供后走 i2i 重设计而非纯文生图 */
  imagePath?: string;
  /** replicate = 结构参考 + 真设计；缺省保持原稿重设计 */
  mode?: string;
  /** 仅 mode=replicate：follow-shell（默认）| new-theme */
  colorMode?: string;
  /** 客户端幂等键（可选）；缺省用服务端 jobId */
  requestId?: string;
  /** 为 true 时用 structure（可空）当结构卡，不再抽 VLM */
  structureProvided?: boolean;
  structure?: unknown;
}

/** 校验原稿图路径归属当前用户（uploads/{userId}/...），返回规范化相对路径 */
function assertOwnedUpload(userId: string, imagePath: unknown): string {
  const rel = parseOwnedUploadRelPath(userId, cleanString(imagePath, 300));
  if (!rel) throw new ApiError('FILE_FORBIDDEN', '原稿图不存在或不属于当前账号', 403, false);
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
  opts: {
    kind: 'single-generate' | 'single-refine';
    refineInstruction?: string;
    sourceImagePath?: string;
    requestId?: string;
    replicate?: boolean;
    colorMode?: ReplicateColorMode;
    structureHint?: SlideStructureCard | null;
  },
  deps: SinglePageDeps,
): Promise<SingleRunResult> {
  const config = deps.config ?? getGenerationConfig();
  const runDeps: SinglePageDeps = { ...deps, config };
  const unitPrice = config.singlePageCredits;
  const jobId = genId('job');
  // 与 credits.cleanKey 同口径归一（trim 后截 128），保证存库的键 = 实际扣费键，崩溃恢复按它找孤儿扣费；
  // 退款键由扣费键定长派生（后缀式退款键在超长 requestId 下会被截回扣费键，退款静默失效）
  const { chargeKey, refundKey } = chargeRefundKeys(`single-page:${page.pageId}:${opts.requestId || jobId}`);
  const { prompt, referencePath } = opts.replicate
    ? { prompt: buildReplicateCopyPrompt({ title: page.title, content: page.content }), referencePath: null }
    : buildPagePrompt(page, opts.refineInstruction);

  const versionId = genId('ver');
  const ts = nowMs();
  markSinglePageActive(page.pageId);
  try {
    // 读页状态 + 落 version + 置 running 同一 BEGIN IMMEDIATE 事务：并发双击只有一路能通过，
    // 另一路拿到 409（否则两路各插版本、各扣一次星，结果 last-writer-wins）
    const started = withTransaction(getGenDb(), () => {
      const current = getGenDb()
        .prepare('SELECT status, error FROM single_pages WHERE id = ? AND user_id = ?')
        .get(page.pageId, page.userId) as Row | undefined;
      if (!current) throw new ApiError('PAGE_NOT_FOUND', '页面不存在', 404, false);
      const status = String(current.status || 'idle');
      if (status === 'running' || status === 'queued') {
        throw new ApiError('GENERATION_RUNNING', '该页正在生成中，请稍候', 409, true);
      }
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
      return { status, error: String(current.error || '') };
    });

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

    // requestId 重放命中幂等键：拒绝且不再生成（否则扣一次费可无限生图，失败分支还会误退首笔）
    if (debit.duplicate) {
      getGenDb().prepare("UPDATE single_page_versions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
        'DUPLICATE_REQUEST',
        nowMs(),
        versionId,
      );
      getGenDb().prepare('UPDATE single_pages SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(
        started.status,
        started.error,
        nowMs(),
        page.pageId,
      );
      throw new ApiError('DUPLICATE_REQUEST', '重复请求：请勿重复提交，刷新后可查看结果', 409, false);
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
        image = await editImage(
          { image: source, instruction: opts.refineInstruction || '', userKey: page.userId },
          runDeps,
        );
      } else if (opts.sourceImagePath) {
        const source = await readSiteFile(opts.sourceImagePath, config);
        if (!source) throw new Error('原稿图不存在或已过期，请重新上传');
        let instruction: string;
        if (opts.replicate) {
          instruction = `${prompt}\n\n${buildReplicateInstruction({
            structure: opts.structureHint ?? null,
            colorMode: opts.colorMode || 'follow-shell',
          })}`;
        } else {
          instruction = `${prompt}\n\n参考上传的原稿图：保留其核心信息、层级与大致版式，按以上需求全面重新设计为精致的一页 16:9 演示页。`;
        }
        image = await editImage({ image: source, instruction, userKey: page.userId }, runDeps);
      } else {
        const pack = resolveStylePack(page.stylePackId);
        const referenceImages = referencePath
          ? [loadStyleReferenceDataUrl(pack, referencePath)].filter((item): item is string => Boolean(item))
          : [];
        image = await generateImage({ prompt, referenceImages, userKey: page.userId }, runDeps);
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
        logProblem({
          category: 'generation',
          level: 'error',
          message: '单页生成失败退款失败',
          detail: refundError,
          userId: page.userId,
          refType: 'single-page',
          refId: page.pageId,
        });
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
  const replicate = cleanString(input.mode, 20) === 'replicate';
  const colorMode = resolveReplicateColorMode(input.colorMode);
  const sourceImagePath = input.imagePath ? assertOwnedUpload(userId, input.imagePath) : undefined;
  if (replicate && !sourceImagePath) throw validationError('复刻需要上传壳页图');
  const existing = getGenDb()
    .prepare('SELECT project_id FROM single_pages WHERE id = ? AND user_id = ?')
    .get(cleanPageId(input.pageId), userId) as Row | undefined;
  const projectIdToCheck = input.projectId || (existing ? String(existing.project_id) : '');
  if (projectIdToCheck && !replicate && readProjectSource(userId, projectIdToCheck) === 'replicate') {
    throw new ApiError('REPLICATE_PROJECT', '这是美化作品，请到 PPT 美化继续生成', 409, false);
  }
  // 先收敛历史中断（否则卡 running 的页会永远 409），upsertPage 内部再做运行中检查
  reconcileSinglePage(userId, cleanPageId(input.pageId));
  const page = upsertPage(userId, {
    ...input,
    pageId: cleanPageId(input.pageId),
    content,
    projectSource: replicate ? 'replicate' : 'single',
    shellPath: replicate ? sourceImagePath : undefined,
  });
  return runSinglePageJob(
    page,
    {
      kind: 'single-generate',
      sourceImagePath,
      requestId: input.requestId,
      replicate,
      colorMode,
      structureHint: input.structureProvided ? parseIncomingStructure(input.structure) : null,
    },
    deps,
  );
}

export async function refineSinglePage(
  userId: string,
  input: { pageId: string; editInstruction: string; requestId?: string },
  deps: SinglePageDeps = {},
): Promise<SingleRunResult> {
  reconcileSinglePage(userId, cleanPageId(input.pageId));
  const page = getOwnedPage(userId, input.pageId);
  if (readProjectSource(userId, page.projectId) === 'replicate') {
    assertFeatureVisible('ppt_replicate', findUserById(userId));
  }
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

/** 批量状态轮询用：页面状态 + 当前生效版本图，不携带完整版本历史。 */
export interface SinglePageStatusView {
  pageId: string;
  pageIndex: number;
  status: SinglePageRow['status'];
  error: string;
  activeVersionId: string;
  imageUrl: string;
  updatedAt: number;
}

export function listSingleProjectPageStatuses(userId: string, projectId: string): SinglePageStatusView[] {
  const db = getGenDb();
  const project = db
    .prepare('SELECT id FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(cleanString(projectId, 80), userId) as Row | undefined;
  if (!project) throw new ApiError('PROJECT_NOT_FOUND', '单页项目不存在', 404, false);
  // 读点即收敛：批量状态轮询也要能解除中断页，调用方不必自己记得恢复
  reconcileSingleProject(userId, String(project.id));
  const rows = db
    .prepare(
      `SELECT p.id, p.page_index, p.status, p.error, p.active_version_id, p.updated_at,
         COALESCE(v.image_url, '') AS image_url
       FROM single_pages p
       LEFT JOIN single_page_versions v ON v.id = p.active_version_id
       WHERE p.project_id = ?
       ORDER BY p.page_index ASC`,
    )
    .all(String(project.id)) as Row[];
  return rows.map((row) => ({
    pageId: String(row.id),
    pageIndex: Number(row.page_index),
    status: String(row.status || 'idle') as SinglePageRow['status'],
    error: String(row.error || ''),
    activeVersionId: String(row.active_version_id || ''),
    imageUrl: String(row.image_url || ''),
    updatedAt: Number(row.updated_at),
  }));
}

/** 打开项目/轮询批量状态前收敛崩溃中断页，返回是否有页面被修复。 */
export function reconcileSingleProject(userId: string, projectId: string): boolean {
  let changed = false;
  for (const page of listSingleProjectPages(userId, projectId)) {
    if (page.status !== 'queued' && page.status !== 'running') continue;
    changed = reconcileSinglePage(userId, page.pageId) || changed;
  }
  return changed;
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

/** 项目详情轮询用：一次取完整个项目的版本，避免逐页查询（N+1）。 */
function listProjectVersions(projectId: string): Map<string, SinglePageVersionView[]> {
  const rows = getGenDb()
    .prepare(
      `SELECT v.* FROM single_page_versions v
       JOIN single_pages p ON p.id = v.page_id
       WHERE p.project_id = ?
       ORDER BY v.page_id ASC, v.created_at DESC, v.rowid DESC`,
    )
    .all(projectId) as Row[];
  const grouped = new Map<string, SinglePageVersionView[]>();
  for (const row of rows) {
    const pageId = String(row.page_id);
    const list = grouped.get(pageId) ?? [];
    list.push({
      versionId: String(row.id),
      kind: String(row.kind || 'generate'),
      status: String(row.status || 'queued') as SinglePageVersionView['status'],
      imageUrl: String(row.image_url || ''),
      error: String(row.error || ''),
      createdAt: Number(row.created_at),
    });
    grouped.set(pageId, list);
  }
  return grouped;
}

/** 单页项目详情（?projectId= 恢复历史页 + 版本列表）；读取时顺带懒恢复中断页 */
export function getSingleProjectDetail(userId: string, projectId: string) {
  const db = getGenDb();
  const project = db
    .prepare('SELECT * FROM single_page_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(cleanString(projectId, 80), userId) as Row | undefined;
  if (!project) throw new ApiError('PROJECT_NOT_FOUND', '单页项目不存在', 404, false);
  reconcileSingleProject(userId, String(project.id));
  const versionsByPage = listProjectVersions(String(project.id));
  const pages = listSingleProjectPages(userId, String(project.id)).map((page) => ({
    ...page,
    versions: versionsByPage.get(page.pageId) ?? [],
  }));
  const pageUpdatedAt = Number(
    db.prepare('SELECT MAX(updated_at) AS m FROM single_pages WHERE project_id = ?').get(String(project.id))?.m || 0,
  );
  return {
    project: {
      id: String(project.id),
      title: String(project.title || ''),
      source: resolveProjectSource(project.source),
      createdAt: Number(project.created_at),
      updatedAt: Math.max(Number(project.updated_at), pageUpdatedAt),
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
  getGenDb()
    .prepare('UPDATE single_page_projects SET updated_at = ? WHERE id = ?')
    .run(nowMs(), page.projectId);
  return getOwnedPage(userId, page.pageId);
}
