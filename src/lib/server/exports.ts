// 图片版 PPTX 导出（pptxgenjs，16:9 逐页整图嵌入）+ 导出中心记录。
// 免费；可编辑导出（Codia 链/轻量文字档）与导出中心查询在 src/modules/editable-export/。
import { createRequire } from 'node:module';
import { ApiError } from './http';
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
// 类型与页面尺寸同时被 editable-export 模块的轻量文字档复用（模块→平台方向允许）。
export interface PptxSlide {
  addImage(opts: { data: string; x: number; y: number; w: number; h: number }): void;
  addText(text: string, opts: Record<string, unknown>): void;
}
export interface PptxInstance {
  layout: string;
  defineLayout(opts: { name: string; width: number; height: number }): void;
  addSlide(): PptxSlide;
  writeFile(opts: { fileName: string }): Promise<string>;
}
export type PptxCtor = new () => PptxInstance;

export const PAGE_W = 13.333; // 16:9 英寸
export const PAGE_H = 7.5;

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
