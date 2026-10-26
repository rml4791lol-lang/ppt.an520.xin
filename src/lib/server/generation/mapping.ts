// outline_page_mapping：真模板（kind=template）路线下，把大纲页逐页对齐到模板页参考图。
// 对齐优先级：逻辑页型精确命中 → 参考桶名直接命中 → 模板页解析后的参考桶命中
// → 内容桶兜底 → 首页兜底。 mapping 在每次生成任务开始时算一次，整批复用。
import type { StylePackTemplatePage } from '../../../data/style-packs'
import type { DeckSlideRow } from './decks'
import { resolvePageType, type PageTypeSpec } from './page-types'
import { cleanString } from './types'

export interface OutlinePageMapping {
  /** 大纲页码（1 起）。 */
  outlinePageNumber: number
  title: string
  /** 归一后的逻辑页型 key。 */
  logicalPageType: string
  /** 命中的模板页下标；-1 表示模板无页可用。 */
  templatePageIndex: number
}

/** 真模板路线的 deck 级上下文：模板页序列 + 大纲↔模板映射，每次生成任务算一次。 */
export interface TemplateRouteContext {
  pages: StylePackTemplatePage[]
  mapping: OutlinePageMapping[]
}

const REFERENCE_BUCKETS = new Set(['cover', 'toc', 'section', 'data', 'process', 'content'])

/** 模板页的参考桶：pageType 是桶名直接用，否则按逻辑页型解析取其 referenceKind。 */
function templatePageBucket(pageType: string): string {
  const clean = cleanString(pageType, 60)
  if (REFERENCE_BUCKETS.has(clean)) return clean
  return resolvePageType(clean, '').referenceKind
}

function pickTemplateIndex(templatePages: StylePackTemplatePage[], spec: PageTypeSpec): number {
  // 1) 逻辑页型精确命中（真模板逐页标注 pageType，如 design/workflow/skill）
  let index = templatePages.findIndex((page) => cleanString(page.pageType, 60) === spec.key)
  if (index >= 0) return index
  // 2) 参考桶名直接命中（参考图模板按桶推导的 pageType）
  index = templatePages.findIndex((page) => cleanString(page.pageType, 60) === spec.referenceKind)
  if (index >= 0) return index
  // 3) 模板页解析后的参考桶命中（真模板的逻辑页型与大纲页同属一个参考桶）
  index = templatePages.findIndex((page) => templatePageBucket(page.pageType) === spec.referenceKind)
  if (index >= 0) return index
  // 4) 内容桶兜底：优先桶名 content，其次解析桶为 content 的模板页
  index = templatePages.findIndex((page) => cleanString(page.pageType, 60) === 'content')
  if (index >= 0) return index
  index = templatePages.findIndex((page) => templatePageBucket(page.pageType) === 'content')
  if (index >= 0) return index
  // 5) 首页兜底
  return templatePages.length > 0 ? 0 : -1
}

/** 大纲页 ↔ 模板页映射：输入大纲页序列与模板页序列，产出逐页对齐结果。 */
export function buildOutlinePageMapping(
  slides: Array<Pick<DeckSlideRow, 'pageIndex' | 'pageType' | 'role' | 'title'>>,
  templatePages: StylePackTemplatePage[],
): OutlinePageMapping[] {
  return slides.map((slide) => {
    const spec = resolvePageType(slide.pageType, slide.role)
    return {
      outlinePageNumber: slide.pageIndex + 1,
      title: cleanString(slide.title, 200),
      logicalPageType: spec.key,
      templatePageIndex: pickTemplateIndex(templatePages, spec),
    }
  })
}

/** 取某一大纲页（0 起 pageIndex）应使用的模板页参考图路径。 */
export function resolveTemplateReferenceImage(
  templatePages: StylePackTemplatePage[],
  mapping: OutlinePageMapping[],
  pageIndex: number,
): string | null {
  const entry = mapping.find((item) => item.outlinePageNumber === pageIndex + 1)
  if (!entry || entry.templatePageIndex < 0) return null
  return templatePages[entry.templatePageIndex]?.imageUrl ?? null
}
