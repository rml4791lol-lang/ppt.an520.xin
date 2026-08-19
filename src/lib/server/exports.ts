// 图片版 PPTX 导出（pptxgenjs，16:9 逐页整图嵌入）+ 导出中心记录。
// 图片版导出免费；可编辑导出为 501 占位（EDITABLE_EXPORT_COMING_SOON，见路由）。
import { createRequire } from 'node:module';
import { ApiError, validationError } from './http';
import { estimateCredits } from './credits';
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
  getGenDb()
    .prepare(
      `INSERT INTO export_jobs (id, user_id, ref_type, ref_id, kind, status, page_count, file_path, file_url, created_at)
       VALUES (?, ?, ?, ?, 'image', 'succeeded', ?, ?, ?, ?)`,
    )
    .run(exportId, userId, refType, refId, pageCount, filePath, fileUrl, nowMs());
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

/** 可编辑导出占位（可编辑链接花卷 Codia，未上线） */
export function exportEditablePptx(): never {
  throw new ApiError('EDITABLE_EXPORT_COMING_SOON', '可编辑导出即将上线', 501, false);
}

// ---------- 导出中心 ----------

type Row = Record<string, string | number | null>;

function toExportView(row: Row) {
  return {
    exportId: String(row.id),
    refType: String(row.ref_type || 'deck'),
    refId: String(row.ref_id || ''),
    kind: String(row.kind || 'image'),
    status: String(row.status || 'succeeded'),
    pageCount: Number(row.page_count),
    url: String(row.file_url || ''),
    createdAt: Number(row.created_at),
  };
}

export function listExports(userId: string, query: { page?: number; pageSize?: number } = {}) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(50, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  const total = Number(
    getGenDb().prepare('SELECT COUNT(*) AS c FROM export_jobs WHERE user_id = ?').get(userId)?.c || 0,
  );
  const rows = getGenDb()
    .prepare('SELECT * FROM export_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(userId, pageSize, (page - 1) * pageSize) as Row[];
  return { items: rows.map(toExportView), total, page, pageSize };
}

export function getExport(userId: string, exportId: string) {
  const row = getGenDb()
    .prepare('SELECT * FROM export_jobs WHERE id = ? AND user_id = ?')
    .get(cleanString(exportId, 80), userId) as Row | undefined;
  if (!row) throw new ApiError('EXPORT_NOT_FOUND', '导出记录不存在', 404, false);
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
    editableUnitPrice = estimateCredits({ action: 'export_editable' }).unitPrice;
  } catch {
    // CREDIT_ACTION_PRICES 被覆盖且不含 export_editable 时用默认 20🌟/页
  }
  return {
    pageCount,
    refType,
    quotes: [
      { kind: 'image', credits: 0, available: pageCount > 0 },
      {
        kind: 'editable',
        credits: editableUnitPrice * pageCount,
        unitPrice: editableUnitPrice,
        available: false,
        code: 'EDITABLE_EXPORT_COMING_SOON',
        message: '可编辑导出即将上线',
      },
    ],
  };
}
