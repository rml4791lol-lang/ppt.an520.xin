// 可编辑导出模块服务端：WPS / Image2PPT / Codia 多通道重转换链（20🌟/页，任务制+懒恢复）
// + 轻量文字可编辑档（VLM 覆盖层，5🌟/页）
// + 导出中心查询（listExports/getExport/quoteExport，含可编辑行的懒恢复触发）。
// 图片版 PPTX 导出在平台件 src/lib/server/exports.ts。
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { ApiError, validationError } from '@/lib/server/http';
import { chargeRefundKeys, debitCredits, estimateCredits, getBalance, refundCredits } from '@/lib/server/credits';
import { verifyImage2PptWebhook } from './image2ppt';
import { editableChargeKey } from './charge-keys';
import { codiaProvider } from './providers/codia';
import {
  LEGACY_EDITABLE_PROVIDER_ID,
  configuredEditableProviders as configuredProviderIds,
  editablePageCapacity as pageCapacity,
  editableProviderById,
  resolveEditableProviders,
} from './providers/registry';
import {
  UPSTREAM_FAILED_MESSAGE,
  UPSTREAM_NO_RESULT_MESSAGE,
  notConfiguredError,
  stageForStatus,
  type EditableProvider,
  type EditableProviderContext,
  type EditableProviderId,
  type EditableProviderView,
  type ProviderStatus,
} from './providers/types';
import { withTransaction } from '@/lib/server/db';
import { chatCompletion } from '@/lib/server/engine';
import { getGenerationConfig, type GenerationConfig } from '@/lib/server/generation/config';
import { genId, getGenDb, nowMs } from '@/lib/server/generation/db';
import { getOwnedDeck, listSlides } from '@/lib/server/generation/decks';
import { getActiveVersionImagePath, listSingleProjectPages } from '@/lib/server/generation/single-pages';
import { reconcileInterruptedRun } from '@/lib/server/generation/recovery';
import { absPathForRelPath, readSiteFile, saveFile } from '@/lib/server/generation/storage';
import { cleanString } from '@/lib/server/generation/types';
import { PAGE_H, PAGE_W, type PptxCtor } from '@/lib/server/exports';
import { logProblem } from '@/lib/server/problem-log';
// ---------- 可编辑导出（WPS / Image2PPT / Codia 多通道） ----------

/** 文字可编辑档不走上游通道（VLM 覆盖层本地组装）：页数上限取产品口径，图片版上限由通道链能力决定。 */
const TEXT_EDITABLE_MAX_PAGES = 50;
/** 超过 20 页的来源视作大套：原始页图会让合成 PDF 超过通道的单文件上限。 */
const LARGE_SOURCE_PAGES = 20;
/** 轮询间隔（官方建议 3-5 秒） */
const POLL_INTERVAL_MS = 4_000;
/** 懒恢复宽限：建行 30s 后仍无上游任务视为进程中断，重跑管线 */
const RECOVERY_GRACE_MS = 30_000;

export interface EditableExportDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
  /** 测试用：覆盖轮询间隔（默认 4s） */
  pollIntervalMs?: number;
  /** 测试用：覆盖 Codia 请求自动恢复的退避时间。 */
  retryDelayMs?: number;
  /** 测试用：覆盖 registry 的通道列表（假通道驱动管线与恢复）。 */
  providers?: readonly EditableProvider[];
}

function snapshotEditableDeps(deps: EditableExportDeps): EditableExportDeps & { config: GenerationConfig } {
  return { ...deps, config: deps.config ?? getGenerationConfig() };
}

export interface StartedEditableExport {
  exportId: string;
  status: 'processing' | 'succeeded';
  credits: number;
  pageCount: number;
  progress: number;
  completedPages: number;
  totalPages: number;
  stage: string;
  url: string;
  /** true = 复用同一来源的进行中/成功任务，本次未再次扣星。 */
  reused: boolean;
  /** 测试用：等待管线结束。路由默认后台执行（void）。 */
  done: Promise<void>;
}

type ExportRow = Record<string, string | number | null>;
type EditableRefType = 'deck' | 'single-page' | 'upload';

/** 已配置的可编辑转换通道，按主通道优先级排序（回退顺序唯一来源在 providers/registry）。 */
export function configuredEditableProviders(config: GenerationConfig): EditableProviderId[] {
  return configuredProviderIds(config);
}

export function isEditableExportConfigured(config: GenerationConfig): boolean {
  return configuredEditableProviders(config).length > 0;
}

/** 可编辑导出的页数上限 = 已配置通道链的能力上限（0 = 没有可用通道）。 */
export function editablePageCapacity(config: GenerationConfig): number {
  return pageCapacity(config);
}

/** 页数上限只有这一处判定：拒绝文案只给能力数字，不暴露供应商名称。 */
function assertEditablePageCount(pageCount: number, capacity: number, scope: string): void {
  if (pageCount <= capacity) return;
  throw new ApiError(
    'EXPORT_TOO_MANY_PAGES',
    `${scope}最多 ${capacity} 页可转可编辑，当前共 ${pageCount} 页`,
    400,
    false,
  );
}

export interface UploadedEditableFile {
  name: string;
  mime: string;
  data: Buffer;
}

interface EditableSourceMeta {
  path?: string;
  name?: string;
  mime?: string;
}


const exportGlobal = globalThis as typeof globalThis & {
  __anpptEditablePipelines?: Map<string, Promise<void>>;
  __anpptEditableFinalizations?: Map<string, Promise<void>>;
};
const editablePipelines = exportGlobal.__anpptEditablePipelines ?? new Map<string, Promise<void>>();
exportGlobal.__anpptEditablePipelines = editablePipelines;
const editableFinalizations = exportGlobal.__anpptEditableFinalizations ?? new Map<string, Promise<void>>();
exportGlobal.__anpptEditableFinalizations = editableFinalizations;

function fingerprintSource(refType: 'deck' | 'single-page', versionIds: string[]): string {
  return createHash('sha256').update(`${refType}\n${versionIds.join('\n')}`).digest('hex');
}

function ensureEditablePipeline(row: ExportRow, deps: EditableExportDeps): Promise<void> {
  const exportId = String(row.id);
  const existing = editablePipelines.get(exportId);
  if (existing) return existing;
  const runDeps = snapshotEditableDeps(deps);
  const runner = String(row.kind) === 'editable_text' ? runTextEditablePipeline : runEditableExportPipeline;
  const running = runner(row, runDeps).finally(() => {
    if (editablePipelines.get(exportId) === running) editablePipelines.delete(exportId);
  });
  editablePipelines.set(exportId, running);
  return running;
}

/** 上传转换源文件仅供后台管线使用；终态后安全删除，避免长期占用磁盘。 */
async function cleanupUploadedEditableSource(row: ExportRow, config: GenerationConfig): Promise<void> {
  if (String(row.ref_type) !== 'upload') return;
  const relPath = String(row.source_path || '').replace(/^\/api\/files\//, '').replace(/^\/+/, '');
  const segments = relPath.split('/').filter(Boolean);
  if (
    segments.length !== 4 ||
    segments[0] !== 'uploads' ||
    segments[1] !== String(row.user_id) ||
    segments[2] !== 'editable-sources'
  ) {
    return;
  }
  const absPath = absPathForRelPath(relPath, config);
  if (!absPath) return;
  try {
    await unlink(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[anppt-v2][exports] cleanup uploaded editable source failed:', error);
    }
  }
}

function updateExportRow(
  exportId: string,
  patch: {
    status?: string;
    error?: string;
    filePath?: string;
    fileUrl?: string;
    upstreamTaskId?: string;
    upstreamProvider?: string;
    progress?: number;
    completedPages?: number;
    stage?: string;
    startedAt?: number;
    completedAt?: number;
  },
): void {
  const sets = ['updated_at = ?'];
  const values: (string | number)[] = [nowMs()];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    values.push(patch.error);
  }
  if (patch.filePath !== undefined) {
    sets.push('file_path = ?');
    values.push(patch.filePath);
  }
  if (patch.fileUrl !== undefined) {
    sets.push('file_url = ?');
    values.push(patch.fileUrl);
  }
  if (patch.upstreamTaskId !== undefined) {
    sets.push('upstream_task_id = ?');
    values.push(patch.upstreamTaskId);
  }
  if (patch.upstreamProvider !== undefined) {
    sets.push('upstream_provider = ?');
    values.push(patch.upstreamProvider);
  }
  if (patch.progress !== undefined) {
    sets.push('progress = MAX(progress, ?)');
    values.push(Math.min(100, Math.max(0, Math.round(patch.progress))));
  }
  if (patch.completedPages !== undefined) {
    sets.push('completed_pages = MAX(completed_pages, ?)');
    values.push(Math.max(0, Math.round(patch.completedPages)));
  }
  if (patch.stage !== undefined) {
    sets.push('stage = ?');
    values.push(cleanString(patch.stage, 200));
  }
  if (patch.startedAt !== undefined) {
    sets.push('started_at = ?');
    values.push(patch.startedAt);
  }
  if (patch.completedAt !== undefined) {
    sets.push('completed_at = ?');
    values.push(patch.completedAt);
  }
  values.push(exportId);
  getGenDb()
    .prepare(`UPDATE export_jobs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

/** 页图 → image-only PDF（PNG/JPEG 每张一页，页尺寸 = 图像素尺寸）。 */
async function buildImagePdf(images: Buffer[]): Promise<Buffer> {
  interface EmbeddedImage {
    width: number;
    height: number;
  }
  interface PdfDoc {
    embedPng(data: Buffer): Promise<EmbeddedImage>;
    embedJpg(data: Buffer): Promise<EmbeddedImage>;
    addPage(size: [number, number]): {
      drawImage(image: EmbeddedImage, opts: { x: number; y: number; width: number; height: number }): void;
    };
    save(): Promise<Uint8Array>;
  }
  const require = createRequire(import.meta.url);
  const { PDFDocument } = require('pdf-lib') as { PDFDocument: { create(): Promise<PdfDoc> } };
  const pdf = await PDFDocument.create();
  const compressPages = images.length > LARGE_SOURCE_PAGES;
  for (const image of images) {
    const isJpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
    const isPng = image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!isJpeg && !isPng) {
      throw new ApiError('UNSUPPORTED_IMAGE', '图片仅支持 PNG、JPG 或 JPEG', 400, false);
    }
    if (compressPages) {
      const compressed = await compressPageImage(image);
      const embedded = await pdf.embedJpg(compressed.data);
      const page = pdf.addPage([compressed.width, compressed.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: compressed.width, height: compressed.height });
      continue;
    }
    const embedded = isJpeg ? await pdf.embedJpg(image) : await pdf.embedPng(image);
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  return Buffer.from(await pdf.save());
}

interface SharpPage {
  rotate(): SharpPage;
  resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): SharpPage;
  flatten(options: { background: { r: number; g: number; b: number } }): SharpPage;
  jpeg(options: { quality: number; chromaSubsampling: string }): SharpPage;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
}

/** 大套页图统一转 JPEG：压到 1920×1080 以内、质量 88、透明处烘白底，保住上游 OCR 可读性。 */
async function compressPageImage(image: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const require = createRequire(import.meta.url);
  const sharp = require('sharp') as (input: Buffer, options?: { limitInputPixels?: number }) => SharpPage;
  const { data, info } = await sharp(image, { limitInputPixels: 100_000_000 })
    .rotate()
    .resize({ width: 1920, height: 1080, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function getPdfPageCount(pdf: Buffer): Promise<number> {
  interface LoadedPdf { getPageCount(): number }
  const require = createRequire(import.meta.url);
  const { PDFDocument } = require('pdf-lib') as {
    PDFDocument: { load(data: Buffer, options?: { ignoreEncryption?: boolean }): Promise<LoadedPdf> };
  };
  try {
    const document = await PDFDocument.load(pdf, { ignoreEncryption: false });
    return document.getPageCount();
  } catch {
    throw new ApiError('INVALID_PDF', 'PDF 无法读取或已加密，请先解除密码后再上传', 400, false);
  }
}

/** 读导出源页图：deck 走 slide_versions、single-page 走 single_page_versions，缺图即抛错 */
async function readExportSourceImages(row: ExportRow, config: GenerationConfig): Promise<Buffer[]> {
  if (String(row.ref_type) === 'single-page') {
    const pages = listSingleProjectPages(String(row.user_id), String(row.ref_id)).filter((page) => page.activeVersionId);
    const images: Buffer[] = [];
    for (const page of pages) {
      const image = await readSiteFile(getActiveVersionImagePath(page), config);
      if (!image) throw new Error(`页面「${page.title}」图片文件缺失`);
      images.push(image);
    }
    return images;
  }
  const images: Buffer[] = [];
  for (const slide of listSlides(String(row.ref_id))) {
    const versionRow = slide.activeVersionId
      ? getGenDb().prepare('SELECT image_path FROM slide_versions WHERE id = ?').get(slide.activeVersionId)
      : null;
    const image = versionRow ? await readSiteFile(String(versionRow.image_path || ''), config) : null;
    if (!image) throw new Error(`第 ${slide.pageIndex + 1} 页图片文件缺失`);
    images.push(image);
  }
  return images;
}

/** 生成管线统一取得 PDF 输入；站内作品先由页图合成，外部文件直接读取已落盘 PDF。 */
async function prepareEditablePdf(row: ExportRow, config: GenerationConfig): Promise<{ pdf: Buffer; pageCount: number }> {
  if (String(row.ref_type) === 'upload') {
    const pdf = await readSiteFile(String(row.source_path || ''), config);
    if (!pdf) throw new Error('上传源文件已丢失，请重新上传');
    return { pdf, pageCount: Number(row.page_count) || (await getPdfPageCount(pdf)) };
  }
  const images = await readExportSourceImages(row, config);
  return { pdf: await buildImagePdf(images), pageCount: images.length };
}

/** 退星（幂等：退款键由扣费键定长派生，重复执行不重复返还）；键前缀与扣费时一致（按 kind 分档） */
function refundEditableCharge(row: ExportRow): void {
  const charged = Number(row.charged_credits) || 0;
  if (charged <= 0) return;
  try {
    const { refundKey } = chargeRefundKeys(
      editableChargeKey({ kind: row.kind, refId: String(row.ref_id), exportId: String(row.id) }),
    );
    refundCredits(String(row.user_id), charged, {
      reason: '可编辑导出失败退回',
      idempotencyKey: refundKey,
      refType: String(row.ref_type || 'deck'),
      refId: String(row.ref_id),
    });
  } catch (error) {
    logProblem({
      category: 'editable',
      level: 'error',
      message: '可编辑导出退款失败',
      detail: error,
      userId: String(row.user_id),
      refType: 'export',
      refId: String(row.id),
    });
  }
}

/** 下载 PPTX 落盘并置行 succeeded。webhook 与轮询可能同时到达，按 exportId 去重。 */
async function saveEditableResult(
  exportId: string,
  userId: string,
  pptUrl: string,
  deps: EditableExportDeps,
  opts: { headers?: Record<string, string>; provider?: EditableProviderId } = {},
): Promise<void> {
  const existing = editableFinalizations.get(exportId);
  if (existing) return existing;
  const run = (async () => {
    const config = deps.config ?? getGenerationConfig();
    const fetchImpl = deps.fetchImpl ?? fetch;
    const current = getGenDb()
      .prepare('SELECT status, file_url FROM export_jobs WHERE id = ?')
      .get(exportId) as ExportRow | undefined;
    if (String(current?.status || '') === 'succeeded' && String(current?.file_url || '')) return;
    updateExportRow(exportId, { status: 'processing', stage: 'downloading' });
    const response = await fetchImpl(pptUrl, {
      headers: opts.headers,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new ApiError('EDITABLE_UPSTREAM_ERROR', `HTTP ${response.status}: PPTX 下载失败`, 502, true);
    }
    if (!response.body) throw new ApiError('EDITABLE_UPSTREAM_ERROR', 'PPTX 下载响应为空', 502, true);
    const contentType = response.headers.get('content-type') || '';
    if (/text\/html/i.test(contentType)) {
      throw new ApiError('EDITABLE_UPSTREAM_ERROR', 'PPTX 下载返回了错误页面', 502, true);
    }
    const saved = await saveFile('exports', userId, Buffer.alloc(0), { ext: '.pptx', id: exportId }, config);
    const partialPath = `${saved.absPath}.part-${process.pid}-${Date.now()}-${opts.provider || 'editable'}`;
    try {
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        createWriteStream(partialPath, { flags: 'wx' }),
      );
      await rename(partialPath, saved.absPath);
    } catch (error) {
      await Promise.allSettled([unlink(partialPath), unlink(saved.absPath)]);
      throw error;
    }
    const row = getGenDb().prepare('SELECT page_count FROM export_jobs WHERE id = ?').get(exportId) as ExportRow | undefined;
    const pageCount = Number(row?.page_count) || 0;
    updateExportRow(exportId, {
      status: 'succeeded',
      filePath: saved.relPath,
      fileUrl: saved.url,
      error: '',
      progress: 100,
      completedPages: pageCount,
      stage: 'completed',
      completedAt: nowMs(),
    });
  })().finally(() => {
    if (editableFinalizations.get(exportId) === run) editableFinalizations.delete(exportId);
  });
  editableFinalizations.set(exportId, run);
  return run;
}

/** WPS 已在内存中返回 PPTX；与 URL 下载共用终态去重，避免恢复管线双写。 */
async function saveEditableBytes(
  exportId: string,
  userId: string,
  bytes: Buffer,
  deps: EditableExportDeps,
): Promise<void> {
  const existing = editableFinalizations.get(exportId);
  if (existing) return existing;
  const run = (async () => {
    const config = deps.config ?? getGenerationConfig();
    const current = getGenDb()
      .prepare('SELECT status, file_url FROM export_jobs WHERE id = ?')
      .get(exportId) as ExportRow | undefined;
    if (String(current?.status || '') === 'succeeded' && String(current?.file_url || '')) return;
    updateExportRow(exportId, { status: 'processing', stage: 'downloading' });
    const saved = await saveFile('exports', userId, Buffer.alloc(0), { ext: '.pptx', id: exportId }, config);
    const partialPath = `${saved.absPath}.part-${process.pid}-${Date.now()}-wps`;
    try {
      await writeFile(partialPath, bytes, { flag: 'wx' });
      await rename(partialPath, saved.absPath);
    } catch (error) {
      await Promise.allSettled([unlink(partialPath), unlink(saved.absPath)]);
      throw error;
    }
    const row = getGenDb().prepare('SELECT page_count FROM export_jobs WHERE id = ?').get(exportId) as ExportRow | undefined;
    updateExportRow(exportId, {
      status: 'succeeded',
      filePath: saved.relPath,
      fileUrl: saved.url,
      error: '',
      progress: 100,
      completedPages: Number(row?.page_count) || 0,
      stage: 'completed',
      completedAt: nowMs(),
    });
  })().finally(() => {
    if (editableFinalizations.get(exportId) === run) editableFinalizations.delete(exportId);
  });
  editableFinalizations.set(exportId, run);
  return run;
}

/** 统一进度落库：通道视图是唯一输入，阶段键由 stageForStatus 产出。 */
function persistProviderProgress(exportId: string, view: EditableProviderView, fallbackTotal: number): void {
  const total = view.totalPages || fallbackTotal;
  const completed = view.status === 'succeeded'
    ? total
    : Math.min(total, Math.max(0, Math.round(view.completedPages)));
  updateExportRow(exportId, {
    status: 'processing',
    progress: view.status === 'succeeded' ? 100 : view.progress,
    completedPages: completed,
    stage: view.stage,
  });
}

/** 适配器拿到的能力：进度回写与落盘都只有管线这一份实现。 */
function providerContext(
  row: ExportRow,
  deps: EditableExportDeps & { config: GenerationConfig },
  pageCount: number,
  providerId: EditableProviderId,
): EditableProviderContext {
  const exportId = String(row.id);
  const userId = String(row.user_id);
  return {
    exportId,
    userId,
    pageCount,
    deps: { fetchImpl: deps.fetchImpl, config: deps.config, retryDelayMs: deps.retryDelayMs },
    report: (partial) => {
      const status = partial.status ?? 'processing';
      persistProviderProgress(exportId, {
        status,
        progress: partial.progress ?? 0,
        completedPages: partial.completedPages ?? 0,
        totalPages: partial.totalPages ?? pageCount,
        stage: partial.stage ?? stageForStatus(status),
        error: partial.error ?? '',
      }, pageCount);
    },
    saveUrl: (url, headers) => saveEditableResult(exportId, userId, url, deps, { headers, provider: providerId }),
    saveBytes: (bytes) => saveEditableBytes(exportId, userId, bytes, deps),
  };
}

function providerDelay(deps: EditableExportDeps): Promise<void> {
  const interval = Math.max(1, deps.pollIntervalMs ?? POLL_INTERVAL_MS);
  return new Promise((resolve) => setTimeout(resolve, interval));
}

/**
 * 用一条通道跑完整条转换：按能力声明的提交次数重建，成功即落盘。
 * 非可重试错误立刻冒泡（由 registry 决定切哪条通道），可重试错误留到下一次提交。
 */
async function convertWithProvider(
  provider: EditableProvider,
  row: ExportRow,
  pdf: Buffer,
  pageCount: number,
  deps: EditableExportDeps & { config: GenerationConfig },
): Promise<void> {
  const exportId = String(row.id);
  const ctx = providerContext(row, deps, pageCount, provider.id);
  updateExportRow(exportId, { upstreamProvider: provider.id, stage: 'uploading' });
  try {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < Math.max(1, provider.capabilities.attempts); attempt += 1) {
      try {
        let step = await provider.start(ctx, { pdf, filename: `${exportId}.pdf`, pageCount, attempt });
        persistProviderProgress(exportId, step.view, pageCount);
        if (step.taskId) updateExportRow(exportId, { upstreamProvider: provider.id, upstreamTaskId: step.taskId });
        while (!step.product) {
          if (step.view.status === 'failed') throw new Error(step.view.error || UPSTREAM_FAILED_MESSAGE);
          if (!provider.capabilities.resumable) throw new Error(step.view.error || UPSTREAM_NO_RESULT_MESSAGE);
          await providerDelay(deps);
          try {
            step = await provider.advance(ctx, step.taskId);
          } catch (error) {
            // 轮询抖动继续等同一个任务：重建任务会多打一次上游付费接口，且旧任务可能随后成功。
            if (error instanceof ApiError && error.retryable) continue;
            throw error;
          }
          persistProviderProgress(exportId, step.view, pageCount);
        }
        await provider.save(ctx, step.product);
        if (step.taskId) updateExportRow(exportId, { upstreamProvider: provider.id, upstreamTaskId: step.taskId });
        return;
      } catch (error) {
        if (error instanceof ApiError && !error.retryable) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(UPSTREAM_FAILED_MESSAGE);
  } finally {
    await provider.cleanup(ctx);
  }
}

/** 按 registry 顺序尝试通道；成功即停，全部失败抛出最后一个错误。 */
async function convertWithProviders(
  providers: readonly EditableProvider[],
  row: ExportRow,
  pdf: Buffer,
  pageCount: number,
  deps: EditableExportDeps & { config: GenerationConfig },
): Promise<void> {
  const exportId = String(row.id);
  let lastError: unknown = null;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    try {
      await convertWithProvider(provider, row, pdf, pageCount, deps);
      return;
    } catch (error) {
      lastError = error;
      const next = providers[index + 1];
      if (!next) throw error;
      console.warn(
        `[anppt-v2][exports] ${provider.id} 失败，切换 ${next.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      updateExportRow(exportId, { stage: 'fallback', upstreamTaskId: '', upstreamProvider: next.id });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(UPSTREAM_FAILED_MESSAGE);
}

/**
 * 可编辑导出管线（不含扣费；扣费只在 start 时发生一次）。
 * 读图 → image-only PDF → 按 registry 顺序转换；失败自动切主备通道。
 * 全部失败/异常 → 退星 + 行标 failed。上游 402（站方余额不足）：终态退星 + 大字日志。
 */
async function runEditableExportPipeline(row: ExportRow, deps: EditableExportDeps): Promise<void> {
  const runDeps = snapshotEditableDeps(deps);
  const config = runDeps.config;
  const exportId = String(row.id);
  try {
    updateExportRow(exportId, { status: 'processing', stage: 'preparing', startedAt: Number(row.started_at) || nowMs() });
    updateExportRow(exportId, { stage: 'building-pdf' });
    const { pdf, pageCount } = await prepareEditablePdf(row, config);
    const providers = runDeps.providers ?? resolveEditableProviders(config, pageCount);
    if (providers.length === 0) {
      throw notConfiguredError();
    }
    await convertWithProviders(providers, row, pdf, pageCount, runDeps);
  } catch (error) {
    const noCredits = error instanceof ApiError && error.code === 'UPSTREAM_NO_CREDITS';
    logProblem({
      category: 'editable',
      level: 'error',
      message: noCredits ? '上游可编辑转换余额不足（402），全部通道失败，站方需尽快充值' : '可编辑导出管线失败',
      detail: error,
      userId: String(row.user_id),
      refType: 'export',
      refId: exportId,
    });
    refundEditableCharge(row);
    updateExportRow(exportId, {
      status: 'failed',
      stage: 'failed',
      completedAt: nowMs(),
      error: noCredits
        ? '可编辑转换服务暂时不可用，星星已退回'
        : '服务器刚刚开了个小差，星星已退回；稍后可重新转换。',
    });
  } finally {
    await cleanupUploadedEditableSource(row, config);
  }
}

/** 发起整套可编辑导出：校验 → 同源任务复用 / 建行扣费 → 后台管线。 */
export async function startDeckEditableExport(
  userId: string,
  deckId: string,
  deps: EditableExportDeps = {},
  options: { force?: boolean } = {},
): Promise<StartedEditableExport> {
  const runDeps = snapshotEditableDeps(deps);
  const config = runDeps.config;
  if (!isEditableExportConfigured(config)) {
    throw notConfiguredError();
  }
  const deck = getOwnedDeck(userId, deckId);
  if (deck.status !== 'generated') {
    throw new ApiError('EXPORT_NOT_READY', '还有页面未生成成功，完成整套生成后才能转可编辑', 409, false);
  }
  const slides = listSlides(deck.id);
  if (slides.length === 0) {
    throw new ApiError('NOTHING_TO_EXPORT', '还没有已生成的页面，无法导出', 409, false);
  }
  assertEditablePageCount(slides.length, pageCapacity(config), '单套');
  const versionIds = slides.map((slide) => cleanString(slide.activeVersionId, 100));
  if (versionIds.some((id) => !id)) {
    throw new ApiError('EXPORT_NOT_READY', '还有页面未生成成功，完成整套生成后才能转可编辑', 409, false);
  }
  return launchEditableExport(
    userId,
    'deck',
    deck.id,
    slides.length,
    fingerprintSource('deck', versionIds),
    runDeps,
    options,
  );
}

type LaunchDecision = { row: ExportRow; created: boolean };

/**
 * 建行 + 扣费 + 启动后台管线（deck / single-page 共用）。
 * - 同项目有进行中任务：无条件复用，避免重复转换/重复扣星；
 * - 同一来源版本已有成功任务：默认复用；仅 force=true 才重新转换；
 * - 查重、建行和扣费位于同一 BEGIN IMMEDIATE 事务，防并发双击竞态。
 * kind 区分重管线（editable=Codia）与轻量文字档（editable_text=VLM 覆盖层），两档记录互不串扰。
 */
async function launchEditableExport(
  userId: string,
  refType: EditableRefType,
  refId: string,
  pageCount: number,
  sourceFingerprint: string,
  deps: EditableExportDeps,
  options: { force?: boolean },
  source: EditableSourceMeta = {},
  kind: 'editable' | 'editable_text' = 'editable',
): Promise<StartedEditableExport> {
  const runDeps = snapshotEditableDeps(deps);
  const db = getGenDb();
  const estimate = estimateCredits({
    action: kind === 'editable_text' ? 'export_editable_text' : 'export_editable',
    pages: pageCount,
  });
  const decision = withTransaction(db, (): LaunchDecision => {
    const running = db
      .prepare(
        `SELECT * FROM export_jobs
         WHERE user_id = ? AND ref_type = ? AND ref_id = ? AND kind = ?
           AND status IN ('pending', 'processing')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, refType, refId, kind) as ExportRow | undefined;
    if (running) return { row: running, created: false };

    if (!options.force) {
      const succeeded = db
        .prepare(
          `SELECT * FROM export_jobs
           WHERE user_id = ? AND ref_type = ? AND ref_id = ? AND kind = ?
             AND status = 'succeeded' AND source_fingerprint = ? AND file_url <> ''
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(userId, refType, refId, kind, sourceFingerprint) as ExportRow | undefined;
      if (succeeded) return { row: succeeded, created: false };
    }

    const balance = getBalance(userId);
    if (balance < estimate.credits) {
      throw new ApiError(
        'INSUFFICIENT_CREDITS',
        `🌟 星星不足：本次需 ${estimate.credits}（${estimate.unitPrice}/页 × ${pageCount} 页），当前余额 ${balance}`,
        402,
        false,
      );
    }

    const exportId = genId('exp');
    const now = nowMs();
    db.prepare(
      `INSERT INTO export_jobs
        (id, user_id, ref_type, ref_id, source_fingerprint, source_path, source_name, source_mime,
         kind, status, page_count, progress, completed_pages, stage, file_path, file_url, error,
         upstream_task_id, charged_credits, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, 'queued', '', '', '', '', ?, ?, ?, ?, 0)`,
    ).run(
      exportId,
      userId,
      refType,
      refId,
      sourceFingerprint,
      source.path || '',
      cleanString(source.name, 200),
      cleanString(source.mime, 100),
      kind,
      pageCount,
      estimate.credits,
      now,
      now,
      now,
    );
    const { chargeKey } = chargeRefundKeys(editableChargeKey({ kind, refId, exportId }));
    debitCredits(userId, estimate.credits, {
      reason: kind === 'editable_text' ? `转文字可编辑 PPTX（${pageCount} 页）` : `转可编辑 PPTX（${pageCount} 页）`,
      idempotencyKey: chargeKey,
      refType,
      refId,
    });
    const row = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(exportId) as ExportRow;
    return { row, created: true };
  });

  let row = decision.row;
  let done: Promise<void>;
  if (decision.created) {
    done = ensureEditablePipeline(row, runDeps);
  } else {
    row = await recoverEditableExport(row, runDeps);
    done = editablePipelines.get(String(row.id)) ?? Promise.resolve();
  }
  const view = toExportView(row, sourceFingerprint);
  return {
    exportId: view.exportId,
    status: view.status === 'succeeded' ? 'succeeded' : 'processing',
    credits: decision.created ? estimate.credits : 0,
    pageCount: view.pageCount,
    progress: view.progress,
    completedPages: view.completedPages,
    totalPages: view.totalPages,
    stage: view.stage,
    url: view.url,
    reused: !decision.created,
    done,
  };
}

/** 单页项目 → 可编辑 PPTX（20🌟/页，同 Codia 管线）。纳入全部成功页，按页序。 */
export async function startSinglePageEditableExport(
  userId: string,
  projectId: string,
  deps: EditableExportDeps = {},
  options: { force?: boolean } = {},
): Promise<StartedEditableExport> {
  const runDeps = snapshotEditableDeps(deps);
  const config = runDeps.config;
  if (!isEditableExportConfigured(config)) {
    throw notConfiguredError();
  }
  const cleanId = cleanString(projectId, 80);
  const pages = listSingleProjectPages(userId, cleanId).filter((page) => page.activeVersionId);
  if (pages.length === 0) {
    throw new ApiError('NOTHING_TO_EXPORT', '还没有已生成的页面，无法导出', 409, false);
  }
  assertEditablePageCount(pages.length, pageCapacity(config), '单套');
  const versionIds = pages.map((page) => cleanString(page.activeVersionId, 100));
  return launchEditableExport(
    userId,
    'single-page',
    cleanId,
    pages.length,
    fingerprintSource('single-page', versionIds),
    runDeps,
    options,
  );
}

/** 上传 PDF 或有序图片 → 可编辑 PPTX。图片会先合成为 image-only PDF，再复用同一 Codia 管线。 */
export async function startUploadedEditableExport(
  userId: string,
  files: UploadedEditableFile[],
  deps: EditableExportDeps = {},
  options: { force?: boolean } = {},
): Promise<StartedEditableExport> {
  const runDeps = snapshotEditableDeps(deps);
  const config = runDeps.config;
  if (!isEditableExportConfigured(config)) {
    throw notConfiguredError();
  }
  if (!Array.isArray(files) || files.length === 0) throw validationError('请选择 PDF 或图片文件');
  const capacity = pageCapacity(config);
  if (files.length > capacity) {
    throw new ApiError('EXPORT_TOO_MANY_PAGES', `单次最多 ${capacity} 个图片文件`, 400, false);
  }
  const totalBytes = files.reduce((sum, file) => sum + file.data.length, 0);
  if (totalBytes <= 0) throw new ApiError('EMPTY_FILE', '文件内容为空', 400, false);
  if (totalBytes > config.uploadMaxBytes) {
    throw new ApiError('FILE_TOO_LARGE', `文件合计不能超过 ${Math.floor(config.uploadMaxBytes / 1024 / 1024)}MB`, 413, false);
  }

  const pdfFiles = files.filter((file) =>
    file.mime === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
  );
  if (pdfFiles.length > 0 && (pdfFiles.length !== 1 || files.length !== 1)) {
    throw validationError('PDF 请单独上传；多张图片可以按顺序一次上传');
  }

  let pdf: Buffer;
  let pageCount: number;
  let sourceName: string;
  if (pdfFiles.length === 1) {
    pdf = pdfFiles[0].data;
    pageCount = await getPdfPageCount(pdf);
    sourceName = cleanString(pdfFiles[0].name, 180) || '上传的 PDF';
  } else {
    pdf = await buildImagePdf(files.map((file) => file.data));
    pageCount = files.length;
    sourceName = files.length === 1
      ? cleanString(files[0].name, 180) || '上传的图片'
      : `${files.length} 张图片`;
  }
  if (pageCount < 1) throw new ApiError('EMPTY_FILE', '文件中没有可转换页面', 400, false);
  assertEditablePageCount(pageCount, capacity, '单次');

  const fingerprint = createHash('sha256').update(pdf).digest('hex');
  const sourceId = `upload_${fingerprint.slice(0, 32)}`;
  const saved = await saveFile('uploads', userId, pdf, { kind: 'editable-sources', ext: '.pdf', id: sourceId }, config);
  const sourceRow: ExportRow = { ref_type: 'upload', user_id: userId, source_path: saved.relPath };
  try {
    const started = await launchEditableExport(
      userId,
      'upload',
      sourceId,
      pageCount,
      fingerprint,
      runDeps,
      options,
      { path: saved.relPath, name: sourceName, mime: 'application/pdf' },
    );
    if (started.reused && started.status === 'succeeded') {
      await cleanupUploadedEditableSource(sourceRow, config);
    }
    return started;
  } catch (error) {
    await cleanupUploadedEditableSource(sourceRow, config);
    throw error;
  }
}

/** 行上的通道：注入的 registry 优先（测试），缺失时回落到历史默认 Codia。 */
function providerForRow(row: ExportRow, deps: EditableExportDeps): EditableProvider {
  const id = String(row.upstream_provider || LEGACY_EDITABLE_PROVIDER_ID);
  return deps.providers?.find((provider) => provider.id === id) ?? editableProviderById(id) ?? codiaProvider;
}

/** 懒恢复（服务器重启不丢单）：editable/editable_text 且 pending/processing 的行现场推进 */
async function recoverEditableExport(row: ExportRow, deps: EditableExportDeps): Promise<ExportRow> {
  const runDeps = snapshotEditableDeps(deps);
  const kind = String(row.kind);
  if (kind !== 'editable' && kind !== 'editable_text') return row;
  if (!['pending', 'processing'].includes(String(row.status))) return row;
  const exportId = String(row.id);
  const taskId = String(row.upstream_task_id || '');
  const pageCount = Number(row.page_count) || 0;
  const provider = kind === 'editable' ? providerForRow(row, runDeps) : null;
  if (provider && taskId) {
    const ctx = providerContext(row, runDeps, pageCount, provider.id);
    try {
      if (!provider.capabilities.resumable) {
        // 没有任务查询端点：已进入转换后进程中断，只能重跑整条管线。
        ensureEditablePipeline(row, runDeps);
      } else {
        const step = await provider.advance(ctx, taskId);
        persistProviderProgress(exportId, step.view, pageCount);
        if (step.product) {
          await provider.save(ctx, step.product);
        } else if (step.view.status === 'failed' || step.view.status === 'succeeded') {
          // 进程可能在第一次失败后、重建任务之前重启；用同一份幂等键重跑管线，
          // 上游返回原任务后按能力声明继续重建（ensure 防止同进程重复启动）。
          ensureEditablePipeline(row, runDeps);
        }
      }
    } catch (error) {
      // 上游暂不可达：保持原状态，下次访问再推进
      console.error('[anppt-v2][exports] editable lazy-recovery poll failed:', error);
      return row;
    }
    return (getGenDb().prepare('SELECT * FROM export_jobs WHERE id = ?').get(exportId) as ExportRow) ?? row;
  }
  if (nowMs() - Number(row.created_at) > RECOVERY_GRACE_MS) {
    // 建行后超过宽限仍无上游任务 = 进程中断：走同一个收敛实现重跑整条管线（可编辑导出是续跑，不是退星）
    // （debit 幂等键 + Codia Idempotency-Key 防重，重跑安全）
    reconcileInterruptedRun({
      key: exportId,
      domain: 'editable-export',
      userId: String(row.user_id),
      settle: () => {
        ensureEditablePipeline(row, runDeps);
      },
      refType: String(row.ref_type || 'deck'),
      refId: String(row.ref_id || ''),
    });
  }
  return row;
}

export interface Image2PptWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/** Image2PPT 完成回调：验签 → 关单推进；下载仍由同一管线完成，避免 webhook/轮询双写。 */
export async function handleImage2PptWebhook(
  rawBody: string,
  headers: Headers,
  deps: EditableExportDeps = {},
): Promise<Image2PptWebhookResult> {
  const runDeps = snapshotEditableDeps(deps);
  if (!runDeps.config.image2pptWebhookSecret) {
    return { status: 503, body: { error: 'webhook_not_configured' } };
  }
  if (!verifyImage2PptWebhook(rawBody, headers, runDeps.config.image2pptWebhookSecret)) {
    return { status: 401, body: { error: 'invalid_signature' } };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { status: 400, body: { error: 'invalid_json' } };
  }
  const data = payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : {};
  const jobId = cleanString(data.jobId, 200);
  if (!jobId) return { status: 400, body: { error: 'missing_job_id' } };
  const row = getGenDb()
    .prepare(
      `SELECT * FROM export_jobs
       WHERE kind = 'editable' AND upstream_provider = 'image2ppt' AND upstream_task_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(jobId) as ExportRow | undefined;
  if (!row) {
    console.warn(`[anppt-v2][image2ppt] webhook job not found: ${jobId}`);
    return { status: 200, body: { ok: true } };
  }
  if (String(row.status) === 'succeeded' || String(row.status) === 'failed') {
    return { status: 200, body: { ok: true } };
  }
  const status = cleanString(data.status, 40).toLowerCase();
  const progress = Math.min(100, Math.max(0, Math.round(Number(data.progress) || 0)));
  const total = Number(data.slideCount) || Number(row.page_count) || 0;
  // 与轮询共用同一份进度落库与阶段映射，避免 webhook 自己再发明一套 stage。
  const providerStatus: ProviderStatus = status === 'completed'
    ? 'succeeded'
    : status === 'failed'
      ? 'failed'
      : status === 'pending' ? 'pending' : 'processing';
  persistProviderProgress(String(row.id), {
    status: providerStatus,
    progress,
    completedPages: Math.min(total, Math.round((progress / 100) * total)),
    totalPages: total,
    stage: stageForStatus(providerStatus),
    error: '',
  }, total);
  if (status === 'completed' || status === 'failed') {
    const latest = getGenDb().prepare('SELECT * FROM export_jobs WHERE id = ?').get(String(row.id)) as ExportRow | undefined;
    if (latest) {
      await recoverEditableExport(latest, runDeps).catch((error) => {
        console.error('[anppt-v2][image2ppt] webhook recovery failed:', error);
      });
    }
  }
  return { status: 200, body: { ok: true } };
}

// ---------- 轻量文字可编辑导出（editable_text_overlay 开关功能，beta） ----------
// 链路：页图 → VLM 提取文字块（位置/字号/颜色/字重/对齐）→ 采样文字周边底色 →
// 整页图垫底 + 同位置纯色底可编辑文本框覆盖（底色块盖住原图文字，省掉擦除 API）。
// 无 Codia 调用，单次成本 ≈ 一次 VLM 识别；单页提取失败降级为纯图片页，全部失败才退星。

export interface SlideTextBlock {
  text: string;
  /** 归一化外接框 [x, y, w, h]，取值 0-1（相对图宽/图高） */
  box: [number, number, number, number];
  /** 字高占图高比例（0-1） */
  fontSizeFrac: number;
  /** 文字主色，6 位 hex 不带 # */
  color: string;
  bold: boolean;
  align: 'left' | 'center' | 'right';
}

type OverlayBlock = SlideTextBlock & { fill: string };

const TEXT_EXTRACT_PROMPT = `你是幻灯片文字版式分析器。识别这张 PPT 页面图中的全部文字块，只输出一个 JSON 数组（不要任何其他文字、解释或代码块标记）。每个元素字段：
- text: 该块文字内容，块内换行用 \\n 表示，逐字提取，不得改写或补全
- box: [x, y, w, h] 文字块外接框，取 0-1 小数（相对图宽与图高的比例）
- fontSize: 字高占图高的比例（0-1 小数，例如 0.045）
- color: 文字主色，六位十六进制（不带 #，例如 "1F2A44"）
- bold: 是否粗体
- align: 水平对齐，"left" | "center" | "right"
规则：按视觉块聚合（标题一块、每组要点一块、每个大数字指标一块、页脚一块……），最多 12 块；纯装饰图形、图标、照片不要报；样式拿不准就按视觉近似估计。`;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeHexColor(value: unknown, fallback = '1F2937'): string {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : fallback;
}

/** 容错解析 VLM 返回的文字块数组（剥离代码块标记、截取首个 [ 到最后一个 ]，逐块校验钳位） */
function parseTextBlocks(raw: string): SlideTextBlock[] {
  const cleaned = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  let list: unknown;
  try {
    list = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
      list = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const blocks: SlideTextBlock[] = [];
  for (const item of list.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text = cleanString(record.text, 600);
    if (!text) continue;
    const boxRaw = Array.isArray(record.box) ? record.box.map(Number) : [];
    if (boxRaw.length !== 4 || boxRaw.some((n) => !Number.isFinite(n))) continue;
    const x = clamp01(boxRaw[0]);
    const y = clamp01(boxRaw[1]);
    const w = clamp01(boxRaw[2]);
    const h = clamp01(boxRaw[3]);
    if (w < 0.01 || h < 0.01 || x + w > 1.02 || y + h > 1.02) continue;
    const fontSizeFrac = clamp01(Number(record.fontSize) || h * 0.55);
    const align = record.align === 'center' || record.align === 'right' ? record.align : 'left';
    blocks.push({
      text,
      box: [x, y, w, h],
      fontSizeFrac,
      color: normalizeHexColor(record.color),
      bold: record.bold === true,
      align,
    });
  }
  return blocks;
}

/** 调 VLM（走 LLM 主备链，用量计入上游统计）提取一页的文字块；失败抛错由调用方降级 */
async function extractSlideTextBlocks(image: Buffer, deps: EditableExportDeps): Promise<SlideTextBlock[]> {
  const dataUrl = `data:image/png;base64,${image.toString('base64')}`;
  const raw = await chatCompletion(
    [{
      role: 'user',
      content: [
        { type: 'text', text: TEXT_EXTRACT_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    deps,
  );
  return parseTextBlocks(raw);
}

/** 采样文字块外围一圈像素取平均色，作为覆盖文本框的底色（模拟"擦除"后的背景）；失败回退白色 */
async function sampleTextBlockFill(image: Buffer, box: [number, number, number, number]): Promise<string> {
  try {
    const require = createRequire(import.meta.url);
    const sharp = require('sharp') as (input: Buffer) => {
      raw(): { toBuffer(opts: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> };
    };
    const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    if (!width || !height || channels < 3) return 'FFFFFF';
    const pad = 4;
    const x0 = Math.max(0, Math.floor(box[0] * width) - pad);
    const y0 = Math.max(0, Math.floor(box[1] * height) - pad);
    const x1 = Math.min(width - 1, Math.ceil((box[0] + box[2]) * width) + pad);
    const y1 = Math.min(height - 1, Math.ceil((box[1] + box[3]) * height) + pad);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    const taste = (x: number, y: number) => {
      const offset = (y * width + x) * channels;
      r += data[offset];
      g += data[offset + 1];
      b += data[offset + 2];
      n += 1;
    };
    for (let x = x0; x <= x1; x += 2) {
      taste(x, y0);
      taste(x, y1);
    }
    for (let y = y0; y <= y1; y += 2) {
      taste(x0, y);
      taste(x1, y);
    }
    if (n === 0) return 'FFFFFF';
    const toHex = (v: number) => Math.round(v / n).toString(16).padStart(2).toUpperCase();
    return `${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch {
    return 'FFFFFF';
  }
}

/** 整页图垫底 + 可编辑文本框覆盖（底色块盖住原图文字）合成 PPTX */
async function buildTextOverlayPptx(
  pages: { image: Buffer; blocks: OverlayBlock[] }[],
  absPath: string,
): Promise<void> {
  const require = createRequire(import.meta.url);
  const PptxGenJS = require('pptxgenjs') as PptxCtor;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'ANPPT_16x9', width: PAGE_W, height: PAGE_H });
  pptx.layout = 'ANPPT_16x9';
  for (const page of pages) {
    const slide = pptx.addSlide();
    slide.addImage({
      data: `data:image/png;base64,${page.image.toString('base64')}`,
      x: 0,
      y: 0,
      w: PAGE_W,
      h: PAGE_H,
    });
    for (const block of page.blocks) {
      slide.addText(block.text, {
        x: block.box[0] * PAGE_W,
        y: block.box[1] * PAGE_H,
        w: block.box[2] * PAGE_W,
        h: block.box[3] * PAGE_H,
        // 页面高 7.5in = 540pt；VLM 字号估计偏乐观，乘 0.92 并 shrink 兜底防溢出
        fontSize: Math.min(120, Math.max(8, Math.round(block.fontSizeFrac * 540 * 0.92))),
        color: block.color,
        bold: block.bold,
        align: block.align,
        valign: 'middle',
        margin: 0,
        wrap: true,
        fit: 'shrink',
        fill: { color: block.fill },
      });
    }
  }
  await pptx.writeFile({ fileName: absPath });
}

/** 轻量文字档管线：读图 → 逐页 VLM 提取 + 底色采样 → 合成落盘。全部页提取失败才整体失败退星。 */
async function runTextEditablePipeline(row: ExportRow, deps: EditableExportDeps): Promise<void> {
  const runDeps = snapshotEditableDeps(deps);
  const config = runDeps.config;
  const exportId = String(row.id);
  try {
    if (String(row.ref_type) === 'upload') throw new Error('轻量文字档暂不支持上传文件来源');
    updateExportRow(exportId, { status: 'processing', stage: 'preparing', startedAt: Number(row.started_at) || nowMs() });
    const images = await readExportSourceImages(row, config);
    if (images.length === 0) throw new Error('没有可转换的页面图');
    const pages: { image: Buffer; blocks: OverlayBlock[] }[] = [];
    let extractFailures = 0;
    for (let index = 0; index < images.length; index += 1) {
      updateExportRow(exportId, { stage: 'extracting' });
      let blocks: SlideTextBlock[] = [];
      try {
        blocks = await extractSlideTextBlocks(images[index], runDeps);
      } catch (error) {
        extractFailures += 1;
        console.error(`[anppt-v2][exports] text overlay extract failed (export ${exportId} page ${index + 1}):`, error);
      }
      const overlaid: OverlayBlock[] = [];
      for (const block of blocks) {
        overlaid.push({ ...block, fill: await sampleTextBlockFill(images[index], block.box) });
      }
      pages.push({ image: images[index], blocks: overlaid });
      updateExportRow(exportId, {
        completedPages: index + 1,
        progress: Math.round(((index + 1) / images.length) * 90),
      });
    }
    if (extractFailures === images.length) throw new Error('文字层提取全部失败');
    updateExportRow(exportId, { stage: 'building-pptx', progress: 95 });
    const saved = await saveFile('exports', String(row.user_id), Buffer.alloc(0), { ext: '.pptx', id: exportId }, config);
    await buildTextOverlayPptx(pages, saved.absPath);
    updateExportRow(exportId, {
      status: 'succeeded',
      filePath: saved.relPath,
      fileUrl: saved.url,
      error: '',
      progress: 100,
      completedPages: images.length,
      stage: 'completed',
      completedAt: nowMs(),
    });
  } catch (error) {
    logProblem({
      category: 'editable',
      level: 'error',
      message: '文字可编辑导出管线失败',
      detail: error,
      userId: String(row.user_id),
      refType: 'export',
      refId: exportId,
    });
    refundEditableCharge(row);
    updateExportRow(exportId, {
      status: 'failed',
      stage: 'failed',
      completedAt: nowMs(),
      error: '文字层提取服务暂时不可用，星星已退回；稍后可重新转换。',
    });
  }
}

/** 发起整套轻量文字可编辑导出（5🌟/页，VLM 覆盖层链）：校验 → 复用/建行扣费 → 后台管线。 */
export async function startDeckTextEditableExport(
  userId: string,
  deckId: string,
  deps: EditableExportDeps = {},
  options: { force?: boolean } = {},
): Promise<StartedEditableExport> {
  const runDeps = snapshotEditableDeps(deps);
  const deck = getOwnedDeck(userId, deckId);
  if (deck.status !== 'generated') {
    throw new ApiError('EXPORT_NOT_READY', '还有页面未生成成功，完成整套生成后才能转文字可编辑', 409, false);
  }
  const slides = listSlides(deck.id);
  if (slides.length === 0) {
    throw new ApiError('NOTHING_TO_EXPORT', '还没有已生成的页面，无法导出', 409, false);
  }
  assertEditablePageCount(slides.length, TEXT_EDITABLE_MAX_PAGES, '单套');
  const versionIds = slides.map((slide) => cleanString(slide.activeVersionId, 100));
  if (versionIds.some((id) => !id)) {
    throw new ApiError('EXPORT_NOT_READY', '还有页面未生成成功，完成整套生成后才能转文字可编辑', 409, false);
  }
  return launchEditableExport(
    userId,
    'deck',
    deck.id,
    slides.length,
    fingerprintSource('deck', versionIds),
    runDeps,
    options,
    {},
    'editable_text',
  );
}

// ---------- 导出中心 ----------

function currentSourceFingerprint(
  userId: string,
  refType: 'deck' | 'single-page',
  refId: string,
): string {
  if (refType === 'single-page') {
    const pages = listSingleProjectPages(userId, refId).filter((page) => page.activeVersionId);
    return pages.length > 0
      ? fingerprintSource('single-page', pages.map((page) => cleanString(page.activeVersionId, 100)))
      : '';
  }
  const slides = listSlides(getOwnedDeck(userId, refId).id);
  const versionIds = slides.map((slide) => cleanString(slide.activeVersionId, 100));
  return versionIds.length > 0 && versionIds.every(Boolean) ? fingerprintSource('deck', versionIds) : '';
}

function toExportView(row: ExportRow, activeFingerprint = '') {
  const kind = String(row.kind || 'image');
  const status = String(row.status || 'succeeded');
  const pageCount = Number(row.page_count) || 0;
  const completed = status === 'succeeded'
    ? pageCount
    : Math.min(pageCount, Math.max(0, Number(row.completed_pages) || 0));
  const progress = status === 'succeeded'
    ? 100
    : Math.min(100, Math.max(0, Number(row.progress) || (pageCount > 0 ? Math.round((completed / pageCount) * 100) : 0)));
  return {
    exportId: String(row.id),
    refType: String(row.ref_type || 'deck'),
    refId: String(row.ref_id || ''),
    sourceName: String(row.source_name || ''),
    kind,
    status,
    pageCount,
    progress,
    completedPages: completed,
    totalPages: pageCount,
    stage: status === 'succeeded' ? 'completed' : String(row.stage || (kind.startsWith('editable') ? 'queued' : '')),
    url: String(row.file_url || ''),
    error: String(row.error || ''),
    chargedCredits: Number(row.charged_credits) || 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at) || Number(row.created_at),
    startedAt: Number(row.started_at) || Number(row.created_at),
    completedAt: Number(row.completed_at) || (status === 'succeeded' ? Number(row.updated_at) : 0),
    isCurrentSource: !activeFingerprint || String(row.source_fingerprint || '') === activeFingerprint,
  };
}

export function listExports(
  userId: string,
  query: {
    page?: number;
    pageSize?: number;
    refType?: EditableRefType;
    refId?: string;
    kind?: 'image' | 'editable' | 'editable_text';
    latest?: boolean;
  } = {},
  deps: EditableExportDeps = {},
) {
  const page = query.latest ? 1 : Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = query.latest ? 1 : Math.min(50, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  const where = ['user_id = ?'];
  const params: (string | number)[] = [userId];
  if (query.refType) {
    where.push('ref_type = ?');
    params.push(query.refType);
  }
  if (query.refId) {
    where.push('ref_id = ?');
    params.push(cleanString(query.refId, 80));
  }
  if (query.kind) {
    where.push('kind = ?');
    params.push(query.kind);
  }
  const whereSql = where.join(' AND ');
  const total = Number(
    getGenDb().prepare(`SELECT COUNT(*) AS c FROM export_jobs WHERE ${whereSql}`).get(...params)?.c || 0,
  );
  const rows = getGenDb()
    .prepare(`SELECT * FROM export_jobs WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as ExportRow[];
  let activeFingerprint = '';
  if (query.refType && query.refType !== 'upload' && query.refId && query.kind?.startsWith('editable')) {
    try {
      activeFingerprint = currentSourceFingerprint(userId, query.refType, cleanString(query.refId, 80));
    } catch {
      activeFingerprint = '';
    }
  }
  // 后台懒恢复进行中的可编辑导出（不阻塞列表响应）
  for (const row of rows) {
    if (String(row.kind).startsWith('editable') && ['pending', 'processing'].includes(String(row.status))) {
      void recoverEditableExport(row, deps).catch(() => {});
    }
  }
  return { items: rows.map((row) => toExportView(row, activeFingerprint)), total, page, pageSize };
}

export async function getExport(userId: string, exportId: string, deps: EditableExportDeps = {}) {
  let row = getGenDb()
    .prepare('SELECT * FROM export_jobs WHERE id = ? AND user_id = ?')
    .get(cleanString(exportId, 80), userId) as ExportRow | undefined;
  if (!row) throw new ApiError('EXPORT_NOT_FOUND', '导出记录不存在', 404, false);
  row = await recoverEditableExport(row, deps);
  let activeFingerprint = '';
  try {
    const refType = String(row.ref_type);
    activeFingerprint = refType === 'upload'
      ? String(row.source_fingerprint || '')
      : currentSourceFingerprint(
          userId,
          refType === 'single-page' ? 'single-page' : 'deck',
          String(row.ref_id),
        );
  } catch {
    activeFingerprint = '';
  }
  return toExportView(row, activeFingerprint);
}

/** 导出报价（对齐旁门 /api/pptx-exports/quote 的三种 body 形态） */
export function quoteExport(userId: string, body: Record<string, unknown>) {
  const deckId = cleanString(body.deckId, 80);
  const projectId = cleanString(body.projectId, 80);
  const pageIds = Array.isArray(body.pageIds) ? body.pageIds.map((id) => cleanString(id, 80)) : [];
  const pageId = cleanString(body.pageId, 80);
  let pageCount = 0;
  let refType = 'deck';
  if (deckId) {
    pageCount = listSlides(getOwnedDeck(userId, deckId).id).filter((slide) => slide.activeVersionId).length;
  } else if (projectId) {
    refType = 'single-page';
    pageCount = listSingleProjectPages(userId, projectId).filter((page) => page.activeVersionId).length;
  } else if (pageIds.length > 0) {
    refType = 'single-page';
    pageCount = pageIds.length;
  } else if (pageId || body.versionId) {
    refType = 'single-page';
    pageCount = 1;
  } else {
    throw validationError('缺少 deckId / projectId / pageIds');
  }
  const editableUnitPrice = estimateCredits({ action: 'export_editable', pages: 1 }).unitPrice;
  const config = getGenerationConfig();
  const providers = resolveEditableProviders(config, pageCount).map((provider) => provider.id);
  const editableAvailable = pageCount > 0 && providers.length > 0;
  return {
    pageCount,
    refType,
    provider: providers[0] || '',
    providers,
    quotes: [
      { kind: 'image', credits: 0, available: pageCount > 0 },
      {
        kind: 'editable',
        credits: editableUnitPrice * pageCount,
        unitPrice: editableUnitPrice,
        available: editableAvailable,
        ...(editableAvailable
          ? {}
          : { code: 'EDITABLE_EXPORT_UNAVAILABLE', message: '可编辑导出暂不可用' }),
      },
    ],
  };
}
