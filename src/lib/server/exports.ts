// 图片版 PPTX 导出（pptxgenjs，16:9 逐页整图嵌入）+ 导出中心记录。
// 图片版导出免费；可编辑导出走 Codia 链（pdf_to_ppt，20🌟/页，任务制 + 懒恢复，
// 失败自动重试一次，再失败退星，无任何降级兜底）。
import { createRequire } from 'node:module';
import { ApiError, validationError } from './http';
import { debitCredits, estimateCredits, getBalance, refundCredits } from './credits';
import { createPdfToPptTask, getTask, uploadPdf, type CodiaTaskView } from './codia';
import { getGenerationConfig, type GenerationConfig } from './generation/config';
import { genId, getGenDb, nowMs } from './generation/db';
import { getOwnedDeck, listSlides } from './generation/decks';
import { getActiveVersionImagePath, getOwnedPage, listSingleProjectPages } from './generation/single-pages';
import { readSiteFile, saveFile } from './generation/storage';
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
      `INSERT INTO export_jobs (id, user_id, ref_type, ref_id, kind, status, page_count, file_path, file_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'image', 'succeeded', ?, ?, ?, ?, ?)`,
    )
    .run(exportId, userId, refType, refId, pageCount, filePath, fileUrl, now, now);
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
  status: 'processing';
  credits: number;
  pageCount: number;
  /** 测试用：等待管线结束。路由默认后台执行（void）。 */
  done: Promise<void>;
}

type ExportRow = Record<string, string | number | null>;

function updateExportRow(
  exportId: string,
  patch: { status?: string; error?: string; filePath?: string; fileUrl?: string; upstreamTaskId?: string },
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
  values.push(exportId);
  getGenDb()
    .prepare(`UPDATE export_jobs SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values);
}

/** 页图 → image-only PDF（每页一张 PNG，页尺寸 = 图像素尺寸）。pdf-lib 走 createRequire 避免打包器内联。 */
async function buildImagePdf(images: Buffer[]): Promise<Buffer> {
  interface EmbeddedImage {
    width: number;
    height: number;
  }
  interface PdfDoc {
    embedPng(data: Buffer): Promise<EmbeddedImage>;
    addPage(size: [number, number]): {
      drawImage(image: EmbeddedImage, opts: { x: number; y: number; width: number; height: number }): void;
    };
    save(): Promise<Uint8Array>;
  }
  const require = createRequire(import.meta.url);
  const { PDFDocument } = require('pdf-lib') as { PDFDocument: { create(): Promise<PdfDoc> } };
  const pdf = await PDFDocument.create();
  for (const image of images) {
    const embedded = await pdf.embedPng(image);
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  }
  return Buffer.from(await pdf.save());
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

/** 轮询上游任务直到终态。429/5xx/网络抖动继续等；402/401/400 冒出由外层处理。不设硬超时（懒恢复兜底）。 */
async function pollCodiaTask(taskId: string, deps: EditableExportDeps): Promise<CodiaTaskView> {
  const interval = Math.max(1, deps.pollIntervalMs ?? POLL_INTERVAL_MS);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    try {
      const view = await getTask(taskId, deps);
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
  const response = await fetchImpl(pptUrl);
  if (!response.ok) throw new ApiError('CODIA_UPSTREAM_ERROR', `HTTP ${response.status}: PPTX 下载失败`, 502, true);
  const buffer = Buffer.from(await response.arrayBuffer());
  const saved = await saveFile('exports', userId, buffer, { ext: '.pptx', id: exportId }, config);
  updateExportRow(exportId, { status: 'succeeded', filePath: saved.relPath, fileUrl: saved.url, error: '' });
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
    const images = await readExportSourceImages(row, config);
    const pdf = await buildImagePdf(images);
    const { uploadId } = await uploadPdf(pdf, `${exportId}.pdf`, deps);
    const pageNo = images.map((_, index) => index);
    let lastError = '上游转换失败';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const idempotencyKey = `anppt-editable-${exportId}${attempt === 1 ? '-retry1' : ''}`;
      try {
        const task = await createPdfToPptTask(
          { uploadId, pageNo, title: `anppt-editable-${exportId}`, idempotencyKey },
          deps,
        );
        updateExportRow(exportId, { upstreamTaskId: task.taskId, status: 'processing' });
        const terminal = await pollCodiaTask(task.taskId, deps);
        if (terminal.status === 'succeeded' && terminal.pptUrl) {
          await saveEditableResult(exportId, String(row.user_id), terminal.pptUrl, deps);
          return;
        }
        lastError = terminal.error || (terminal.status === 'canceled' ? '上游任务被取消' : '上游未返回可下载文件');
      } catch (error) {
        if (error instanceof ApiError && error.code === 'UPSTREAM_NO_CREDITS') throw error;
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
      error: noCredits
        ? '可编辑转换服务暂时不可用，星星已退回'
        : `可编辑转换失败，星星已退回（${cleanString(error instanceof Error ? error.message : String(error), 150)}）`,
    });
  }
}

/** 发起整套可编辑导出：校验 → 建行 → 扣费 → 后台管线。 */
export async function startDeckEditableExport(
  userId: string,
  deckId: string,
  deps: EditableExportDeps = {},
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
  return launchEditableExport(userId, 'deck', deck.id, slides.length, deps);
}

/** 建行 + 扣费 + 启动后台管线（deck / single-page 共用）。余额不足 402 不建行不扣费。 */
function launchEditableExport(
  userId: string,
  refType: 'deck' | 'single-page',
  refId: string,
  pageCount: number,
  deps: EditableExportDeps,
): StartedEditableExport {
  const running = getGenDb()
    .prepare(
      `SELECT id FROM export_jobs
       WHERE user_id = ? AND ref_type = ? AND ref_id = ? AND kind = 'editable' AND status IN ('pending', 'processing')
       LIMIT 1`,
    )
    .get(userId, refType, refId);
  if (running) {
    throw new ApiError('EXPORT_RUNNING', '该项目的可编辑转换正在进行中，完成后可再次发起', 409, true);
  }
  // 整单估价 + 余额校验
  const estimate = estimateCredits({ action: 'export_editable', pages: pageCount });
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
  getGenDb()
    .prepare(
      `INSERT INTO export_jobs
        (id, user_id, ref_type, ref_id, kind, status, page_count, file_path, file_url, error, upstream_task_id, charged_credits, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'editable', 'pending', ?, '', '', '', '', ?, ?, ?)`,
    )
    .run(exportId, userId, refType, refId, pageCount, estimate.credits, now, now);
  try {
    debitCredits(userId, estimate.credits, {
      reason: `转可编辑 PPTX（${pageCount} 页）`,
      idempotencyKey: `export-editable:${refId}:${exportId}`,
      refType,
      refId,
    });
  } catch (error) {
    // 余额竞争等扣费失败：不留孤儿行
    getGenDb().prepare('DELETE FROM export_jobs WHERE id = ?').run(exportId);
    throw error;
  }

  const row = getGenDb().prepare('SELECT * FROM export_jobs WHERE id = ?').get(exportId) as ExportRow;
  const done = runEditableExportPipeline(row, deps);
  return { exportId, status: 'processing', credits: estimate.credits, pageCount, done };
}

/** 单页项目 → 可编辑 PPTX（20🌟/页，同 Codia 管线）。纳入全部成功页，按页序。 */
export async function startSinglePageEditableExport(
  userId: string,
  projectId: string,
  deps: EditableExportDeps = {},
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
  return launchEditableExport(userId, 'single-page', cleanId, pages.length, deps);
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
      if (view.status === 'succeeded' && view.pptUrl) {
        await saveEditableResult(exportId, String(row.user_id), view.pptUrl, deps);
      } else if (view.status === 'failed' || view.status === 'canceled') {
        refundEditableCharge(row);
        updateExportRow(exportId, {
          status: 'failed',
          error: `可编辑转换失败，星星已退回（${view.error || '上游任务失败'}）`,
        });
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
    void runEditableExportPipeline(row, deps);
  }
  return row;
}

// ---------- 导出中心 ----------

function toExportView(row: ExportRow) {
  return {
    exportId: String(row.id),
    refType: String(row.ref_type || 'deck'),
    refId: String(row.ref_id || ''),
    kind: String(row.kind || 'image'),
    status: String(row.status || 'succeeded'),
    pageCount: Number(row.page_count),
    url: String(row.file_url || ''),
    error: String(row.error || ''),
    chargedCredits: Number(row.charged_credits) || 0,
    createdAt: Number(row.created_at),
  };
}

export function listExports(
  userId: string,
  query: { page?: number; pageSize?: number } = {},
  deps: EditableExportDeps = {},
) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  const total = Number(
    getGenDb().prepare('SELECT COUNT(*) AS c FROM export_jobs WHERE user_id = ?').get(userId)?.c || 0,
  );
  const rows = getGenDb()
    .prepare('SELECT * FROM export_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(userId, pageSize, (page - 1) * pageSize) as ExportRow[];
  // 后台懒恢复进行中的可编辑导出（不阻塞列表响应）
  for (const row of rows) {
    if (String(row.kind) === 'editable' && ['pending', 'processing'].includes(String(row.status))) {
      void recoverEditableExport(row, deps).catch(() => {});
    }
  }
  return { items: rows.map(toExportView), total, page, pageSize };
}

export async function getExport(userId: string, exportId: string, deps: EditableExportDeps = {}) {
  let row = getGenDb()
    .prepare('SELECT * FROM export_jobs WHERE id = ? AND user_id = ?')
    .get(cleanString(exportId, 80), userId) as ExportRow | undefined;
  if (!row) throw new ApiError('EXPORT_NOT_FOUND', '导出记录不存在', 404, false);
  row = await recoverEditableExport(row, deps);
  return toExportView(row);
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
