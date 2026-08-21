// 图片版 PPTX 导出（pptxgenjs，16:9 逐页整图嵌入）+ 导出中心记录。
// 图片版导出免费；可编辑导出走 Codia 链（pdf_to_ppt，20🌟/页，任务制 + 懒恢复，
// 失败自动重试一次，再失败退星，无任何降级兜底）。
import { createRequire } from 'node:module';
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { ApiError, validationError } from './http';
import { debitCredits, estimateCredits, getBalance, refundCredits } from './credits';
import { createPdfToPptTask, getTask, uploadPdf, type CodiaTaskView } from './codia';
import { withTransaction } from './db';
import { getGenerationConfig, type GenerationConfig } from './generation/config';
import { genId, getGenDb, nowMs } from './generation/db';
import { getOwnedDeck, listSlides } from './generation/decks';
import { getActiveVersionImagePath, getOwnedPage, listSingleProjectPages } from './generation/single-pages';
import { absPathForRelPath, readSiteFile, saveFile } from './generation/storage';
import { cleanString } from './generation/types';

export interface ExportDeps {
  config?: GenerationConfig;
}

// pptxgenjs 用 createRequire 走 node_modules 真实路径，避免打包器内联（jszip/fs 动态引用）。
interface PptxSlide {
  addImage(opts: { data: string; x: number; y: number; w: number; h: number }): void;
}
interface PptxInstance {
  layout: string;
  defineLayout(opts: { name: string; width: number; height: number }): void;
  addSlide(): PptxSlide;
  writeFile(opts: { fileName: string }): Promise<string>;
}
type PptxCtor = new () => PptxInstance;

const PAGE_W = 13.333; // 16:9 英寸
const PAGE_H = 7.5;

async function buildImagePptx(
  pages: { image: Buffer; title: string }[],
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
  }
  await pptx.writeFile({ fileName: absPath });
}

function recordExport(
  exportId: string,
  userId: string,
  refType: 'deck' | 'single-page',
  refId: string,
  pageCount: number,
  filePath: string,
  fileUrl: string,
): void {
  const now = nowMs();
  getGenDb()
    .prepare(
      `INSERT INTO export_jobs
        (id, user_id, ref_type, ref_id, kind, status, page_count, progress, completed_pages, stage,
         file_path, file_url, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'image', 'succeeded', ?, 100, ?, 'completed', ?, ?, ?, ?, ?, ?)`,
    )
    .run(exportId, userId, refType, refId, pageCount, pageCount, filePath, fileUrl, now, now, now, now);
}

export interface ExportResult {
  exportId: string;
  url: string;
  pageCount: number;
  kind: 'image';
}

/** 整套 PPT → 图片版 PPTX（免费）。仅纳入有成功生成图的页，按 pageIndex 排序。 */
export async function exportDeckImagePptx(
  userId: string,
  deckId: string,
  deps: ExportDeps = {},
): Promise<ExportResult> {
  const config = deps.config ?? getGenerationConfig();
  const deck = getOwnedDeck(userId, deckId);
  const slides = listSlides(deck.id).filter((slide) => slide.activeVersionId);
  if (slides.length === 0) {
    throw new ApiError('NOTHING_TO_EXPORT', '还没有已生成的页面，无法导出', 409, false);
  }
  const pages: { image: Buffer; title: string }[] = [];
  for (const slide of slides) {
    const row = getGenDb()
      .prepare('SELECT image_path FROM slide_versions WHERE id = ?')
      .get(slide.activeVersionId);
    const image = row ? await readSiteFile(String(row.image_path || ''), config) : null;
    if (!image) {
      throw new ApiError('EXPORT_ASSET_MISSING', `第 ${slide.pageIndex + 1} 页图片文件缺失，请重新生成该页`, 409, true);
    }
    pages.push({ image, title: slide.title });
  }
  const exportId = genId('exp');
  const saved = await saveFile('exports', userId, Buffer.alloc(0), { ext: '.pptx', id: exportId }, config);
  await buildImagePptx(pages, saved.absPath);
  recordExport(exportId, userId, 'deck', deck.id, pages.length, saved.relPath, saved.url);
  return { exportId, url: saved.url, pageCount: pages.length, kind: 'image' };
}

/** 单页生成器 → 图片版 PPTX（免费）。按项目页序或指定 pageIds 顺序。 */
export async function exportSinglePagesImagePptx(
  userId: string,
  input: { projectId?: string; pageIds?: string[]; title?: string },
  deps: ExportDeps = {},
): Promise<ExportResult> {
  const config = deps.config ?? getGenerationConfig();
  let pages = input.projectId ? listSingleProjectPages(userId, input.projectId) : [];
  if (input.pageIds && input.pageIds.length > 0) {
    pages = input.pageIds.map((id) => getOwnedPage(userId, cleanString(id, 80)));
    if (input.projectId) {
      for (const page of pages) {
        if (page.projectId !== input.projectId) {
          throw new ApiError('PAGE_NOT_FOUND', `页面 ${page.pageId} 不在该项目中`, 404, false);
        }
      }
    }
  }
  const withImages = pages.filter((page) => page.activeVersionId);
  if (withImages.length === 0) {
    throw new ApiError('NOTHING_TO_EXPORT', '还没有已生成的页面，无法导出', 409, false);
  }
  const images: { image: Buffer; title: string }[] = [];
  for (const page of withImages) {
    const image = await readSiteFile(getActiveVersionImagePath(page), config);
    if (!image) {
      throw new ApiError('EXPORT_ASSET_MISSING', `页面「${page.title}」图片文件缺失，请重新生成`, 409, true);
    }
    images.push({ image, title: page.title });
  }
  const exportId = genId('exp');
  const saved = await saveFile('exports', userId, Buffer.alloc(0), { ext: '.pptx', id: exportId }, config);
  await buildImagePptx(images, saved.absPath);
  recordExport(exportId, userId, 'single-page', input.projectId || withImages[0].projectId, images.length, saved.relPath, saved.url);
  return { exportId, url: saved.url, pageCount: images.length, kind: 'image' };
}

// ---------- 可编辑导出（Codia 链） ----------

/** Codia 单任务页数上限（官方限制 ≤20 页/任务） */
const EDITABLE_MAX_PAGES = 20;
/** 轮询间隔（官方建议 3-5 秒） */
const POLL_INTERVAL_MS = 4_000;
/** 懒恢复宽限：建行 30s 后仍无上游任务视为进程中断，重跑管线 */
const RECOVERY_GRACE_MS = 30_000;

export interface EditableExportDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
  /** 测试用：覆盖轮询间隔（默认 4s） */
  pollIntervalMs?: number;
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
};
const editablePipelines = exportGlobal.__anpptEditablePipelines ?? new Map<string, Promise<void>>();
exportGlobal.__anpptEditablePipelines = editablePipelines;

function fingerprintSource(refType: 'deck' | 'single-page', versionIds: string[]): string {
  return createHash('sha256').update(`${refType}\n${versionIds.join('\n')}`).digest('hex');
}

function ensureEditablePipeline(row: ExportRow, deps: EditableExportDeps): Promise<void> {
  const exportId = String(row.id);
  const existing = editablePipelines.get(exportId);
  if (existing) return existing;
  const running = runEditableExportPipeline(row, deps).finally(() => {
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
  for (const image of images) {
    const isJpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
    const isPng = image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!isJpeg && !isPng) {
      throw new ApiError('UNSUPPORTED_IMAGE', '图片仅支持 PNG、JPG 或 JPEG', 400, false);
    }
    const embedded = isJpeg ? await pdf.embedJpg(image) : await pdf.embedPng(image);
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  return Buffer.from(await pdf.save());
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

/** 退星（幂等：refund 键唯一，重复执行不重复返还） */
function refundEditableCharge(row: ExportRow): void {
  const charged = Number(row.charged_credits) || 0;
  if (charged <= 0) return;
  try {
    refundCredits(String(row.user_id), charged, {
      reason: '可编辑导出失败退回',
      idempotencyKey: `export-editable:${row.ref_id}:${row.id}:refund`,
      refType: String(row.ref_type || 'deck'),
      refId: String(row.ref_id),
    });
  } catch (error) {
    console.error('[anppt-v2][exports] editable refund failed:', error);
  }
}

function codiaStage(view: CodiaTaskView): string {
  if (view.stage) return view.stage;
  if (view.status === 'pending') return 'waiting';
  if (view.status === 'processing') return 'converting';
  if (view.status === 'succeeded') return 'saving';
  return 'failed';
}

function persistCodiaProgress(exportId: string, view: CodiaTaskView, fallbackTotal: number): void {
  const total = view.totalPages || view.pageCount || fallbackTotal;
  updateExportRow(exportId, {
    status: view.status === 'pending' ? 'processing' : view.status,
    progress: view.status === 'succeeded' ? 100 : view.progress,
    completedPages: view.status === 'succeeded' ? total : view.completedPages,
    stage: codiaStage(view),
  });
}

/** 轮询上游任务直到终态。429/5xx/网络抖动继续等；402/401/400 冒出由外层处理。不设硬超时（懒恢复兜底）。 */
async function pollCodiaTask(
  exportId: string,
  taskId: string,
  pageCount: number,
  deps: EditableExportDeps,
): Promise<CodiaTaskView> {
  const interval = Math.max(1, deps.pollIntervalMs ?? POLL_INTERVAL_MS);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    try {
      const view = await getTask(taskId, deps);
      persistCodiaProgress(exportId, view, pageCount);
      if (view.status === 'succeeded' || view.status === 'failed' || view.status === 'canceled') return view;
    } catch (error) {
      if (error instanceof ApiError && !error.retryable) throw error;
    }
  }
}

/** 下载 PPTX 落盘并置行 succeeded */
async function saveEditableResult(
  exportId: string,
  userId: string,
  pptUrl: string,
  deps: EditableExportDeps,
): Promise<void> {
  const config = deps.config ?? getGenerationConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  updateExportRow(exportId, { status: 'processing', stage: 'downloading' });
  const response = await fetchImpl(pptUrl);
  if (!response.ok) throw new ApiError('CODIA_UPSTREAM_ERROR', `HTTP ${response.status}: PPTX 下载失败`, 502, true);
  if (!response.body) throw new ApiError('CODIA_UPSTREAM_ERROR', 'PPTX 下载响应为空', 502, true);
  const saved = await saveFile('exports', userId, Buffer.alloc(0), { ext: '.pptx', id: exportId }, config);
  const partialPath = `${saved.absPath}.part-${process.pid}-${Date.now()}`;
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
}

/**
 * 可编辑导出管线（不含扣费；扣费只在 start 时发生一次）。
 * 读图 → image-only PDF → 上传 → 建任务 → 轮询 → 下载落盘。
 * failed 自动以 `-retry1` 幂等键重建一次（上游幂等退 credits，不双扣）；
 * 再失败/异常 → 退星 + 行标 failed。上游 402（站方余额不足）：立即终态退星 + 大字日志。
 */
async function runEditableExportPipeline(row: ExportRow, deps: EditableExportDeps): Promise<void> {
  const config = deps.config ?? getGenerationConfig();
  const exportId = String(row.id);
  try {
    updateExportRow(exportId, { status: 'processing', stage: 'preparing', startedAt: Number(row.started_at) || nowMs() });
    updateExportRow(exportId, { stage: 'building-pdf' });
    const { pdf, pageCount } = await prepareEditablePdf(row, config);
    updateExportRow(exportId, { stage: 'uploading' });
    const { uploadId } = await uploadPdf(pdf, `${exportId}.pdf`, deps);
    const pageNo = Array.from({ length: pageCount }, (_, index) => index);
    let lastError = '上游转换失败';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const idempotencyKey = `anppt-editable-${exportId}${attempt === 1 ? '-retry1' : ''}`;
      try {
        const task = await createPdfToPptTask(
          { uploadId, pageNo, title: `anppt-editable-${exportId}`, idempotencyKey },
          deps,
        );
        updateExportRow(exportId, { upstreamTaskId: task.taskId, status: 'processing', stage: 'waiting' });
        const terminal = await pollCodiaTask(exportId, task.taskId, pageCount, deps);
        if (terminal.status === 'succeeded' && terminal.pptUrl) {
          await saveEditableResult(exportId, String(row.user_id), terminal.pptUrl, deps);
          return;
        }
        lastError = terminal.error || (terminal.status === 'canceled' ? '上游任务被取消' : '上游未返回可下载文件');
      } catch (error) {
        if (error instanceof ApiError && !error.retryable) throw error;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(lastError);
  } catch (error) {
    const noCredits = error instanceof ApiError && error.code === 'UPSTREAM_NO_CREDITS';
    if (noCredits) {
      console.error('[anppt-v2][codia] ⚠️⚠️ 上游 Codia 余额不足（402），可编辑导出全部失败，站方需尽快充值！');
    } else {
      console.error('[anppt-v2][exports] editable pipeline failed:', error);
    }
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
  const config = deps.config ?? getGenerationConfig();
  if (!config.codiaApiKey) {
    throw new ApiError('EDITABLE_EXPORT_UNAVAILABLE', '可编辑导出尚未配置，请联系管理员', 503, false);
  }
  const deck = getOwnedDeck(userId, deckId);
  if (deck.status !== 'generated') {
    throw new ApiError('EXPORT_NOT_READY', '还有页面未生成成功，完成整套生成后才能转可编辑', 409, false);
  }
  const slides = listSlides(deck.id);
  if (slides.length === 0) {
    throw new ApiError('NOTHING_TO_EXPORT', '还没有已生成的页面，无法导出', 409, false);
  }
  if (slides.length > EDITABLE_MAX_PAGES) {
    throw new ApiError(
      'EXPORT_TOO_MANY_PAGES',
      `单套最多 ${EDITABLE_MAX_PAGES} 页可转可编辑，当前共 ${slides.length} 页`,
      400,
      false,
    );
  }
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
    deps,
    options,
  );
}

type LaunchDecision = { row: ExportRow; created: boolean };

/**
 * 建行 + 扣费 + 启动后台管线（deck / single-page 共用）。
 * - 同项目有进行中任务：无条件复用，避免重复转换/重复扣星；
 * - 同一来源版本已有成功任务：默认复用；仅 force=true 才重新转换；
 * - 查重、建行和扣费位于同一 BEGIN IMMEDIATE 事务，防并发双击竞态。
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
): Promise<StartedEditableExport> {
  const db = getGenDb();
  const estimate = estimateCredits({ action: 'export_editable', pages: pageCount });
  const decision = withTransaction(db, (): LaunchDecision => {
    const running = db
      .prepare(
        `SELECT * FROM export_jobs
         WHERE user_id = ? AND ref_type = ? AND ref_id = ? AND kind = 'editable'
           AND status IN ('pending', 'processing')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, refType, refId) as ExportRow | undefined;
    if (running) return { row: running, created: false };

    if (!options.force) {
      const succeeded = db
        .prepare(
          `SELECT * FROM export_jobs
           WHERE user_id = ? AND ref_type = ? AND ref_id = ? AND kind = 'editable'
             AND status = 'succeeded' AND source_fingerprint = ? AND file_url <> ''
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(userId, refType, refId, sourceFingerprint) as ExportRow | undefined;
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'editable', 'pending', ?, 0, 0, 'queued', '', '', '', '', ?, ?, ?, ?, 0)`,
    ).run(
      exportId,
      userId,
      refType,
      refId,
      sourceFingerprint,
      source.path || '',
      cleanString(source.name, 200),
      cleanString(source.mime, 100),
      pageCount,
      estimate.credits,
      now,
      now,
      now,
    );
    debitCredits(userId, estimate.credits, {
      reason: `转可编辑 PPTX（${pageCount} 页）`,
      idempotencyKey: `export-editable:${refId}:${exportId}`,
      refType,
      refId,
    });
    const row = db.prepare('SELECT * FROM export_jobs WHERE id = ?').get(exportId) as ExportRow;
    return { row, created: true };
  });

  let row = decision.row;
  let done: Promise<void>;
  if (decision.created) {
    done = ensureEditablePipeline(row, deps);
  } else {
    row = await recoverEditableExport(row, deps);
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
  const config = deps.config ?? getGenerationConfig();
  if (!config.codiaApiKey) {
    throw new ApiError('EDITABLE_EXPORT_UNAVAILABLE', '可编辑导出尚未配置，请联系管理员', 503, false);
  }
  const cleanId = cleanString(projectId, 80);
  const pages = listSingleProjectPages(userId, cleanId).filter((page) => page.activeVersionId);
  if (pages.length === 0) {
    throw new ApiError('NOTHING_TO_EXPORT', '还没有已生成的页面，无法导出', 409, false);
  }
  if (pages.length > EDITABLE_MAX_PAGES) {
    throw new ApiError(
      'EXPORT_TOO_MANY_PAGES',
      `单套最多 ${EDITABLE_MAX_PAGES} 页可转可编辑，当前共 ${pages.length} 页`,
      400,
      false,
    );
  }
  const versionIds = pages.map((page) => cleanString(page.activeVersionId, 100));
  return launchEditableExport(
    userId,
    'single-page',
    cleanId,
    pages.length,
    fingerprintSource('single-page', versionIds),
    deps,
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
  const config = deps.config ?? getGenerationConfig();
  if (!config.codiaApiKey) {
    throw new ApiError('EDITABLE_EXPORT_UNAVAILABLE', '可编辑转换服务尚未配置，请联系管理员', 503, false);
  }
  if (!Array.isArray(files) || files.length === 0) throw validationError('请选择 PDF 或图片文件');
  if (files.length > EDITABLE_MAX_PAGES) {
    throw new ApiError('EXPORT_TOO_MANY_PAGES', `单次最多 ${EDITABLE_MAX_PAGES} 个图片文件`, 400, false);
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
  if (pageCount > EDITABLE_MAX_PAGES) {
    throw new ApiError(
      'EXPORT_TOO_MANY_PAGES',
      `单次最多 ${EDITABLE_MAX_PAGES} 页可转可编辑，当前共 ${pageCount} 页`,
      400,
      false,
    );
  }

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
      deps,
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

/** 懒恢复（服务器重启不丢单）：editable 且 pending/processing 的行现场推进 */
async function recoverEditableExport(row: ExportRow, deps: EditableExportDeps): Promise<ExportRow> {
  if (String(row.kind) !== 'editable') return row;
  if (!['pending', 'processing'].includes(String(row.status))) return row;
  const exportId = String(row.id);
  const taskId = String(row.upstream_task_id || '');
  if (taskId) {
    // 已有上游任务：现场 poll 一次并推进状态
    try {
      const view = await getTask(taskId, deps);
      persistCodiaProgress(exportId, view, Number(row.page_count) || 0);
      if (view.status === 'succeeded' && view.pptUrl) {
        await saveEditableResult(exportId, String(row.user_id), view.pptUrl, deps);
      } else if (view.status === 'failed' || view.status === 'canceled') {
        // 进程可能在第一次失败后、创建 retry1 之前重启。用同一幂等键重跑管线，
        // 由 Codia 返回原 failed 任务后继续 retry1；ensure 防止同进程重复启动。
        ensureEditablePipeline(row, deps);
      }
    } catch (error) {
      // 上游暂不可达：保持原状态，下次访问再推进
      console.error('[anppt-v2][exports] editable lazy-recovery poll failed:', error);
      return row;
    }
    return (getGenDb().prepare('SELECT * FROM export_jobs WHERE id = ?').get(exportId) as ExportRow) ?? row;
  }
  if (nowMs() - Number(row.created_at) > RECOVERY_GRACE_MS) {
    // 建行后未建上游任务（进程中断）：后台重跑整条管线
    // （debit 幂等键 + Codia Idempotency-Key 防重，重跑安全）
    ensureEditablePipeline(row, deps);
  }
  return row;
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
    stage: status === 'succeeded' ? 'completed' : String(row.stage || (kind === 'editable' ? 'queued' : '')),
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
    kind?: 'image' | 'editable';
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
  if (query.refType && query.refType !== 'upload' && query.refId && query.kind === 'editable') {
    try {
      activeFingerprint = currentSourceFingerprint(userId, query.refType, cleanString(query.refId, 80));
    } catch {
      activeFingerprint = '';
    }
  }
  // 后台懒恢复进行中的可编辑导出（不阻塞列表响应）
  for (const row of rows) {
    if (String(row.kind) === 'editable' && ['pending', 'processing'].includes(String(row.status))) {
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
  let editableUnitPrice = 20;
  try {
    editableUnitPrice = estimateCredits({ action: 'export_editable', pages: 1 }).unitPrice;
  } catch {
    // CREDIT_ACTION_PRICES 被覆盖且不含 export_editable 时用默认 20🌟/页
  }
  const editableAvailable = pageCount > 0 && Boolean(getGenerationConfig().codiaApiKey);
  return {
    pageCount,
    refType,
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
