// 每页视觉计划：整套路径的页型、提示词与参考图的唯一决策点。
// 页型只解析一次，模板映射与提示词都读同一个键；参考图按锚点 > 模板样张 > 风格样张
// 排成完整候选（调用方按序取第一个可读的，不在某个分支里悄悄丢图）。
import type { EngineDeps } from '../engine'
import { ensureDeckBlueprint } from './blueprint'
import type { DeckRow, DeckSlideRow } from './decks'
import { extractCopyFromDsl } from './dsl'
import { resolveTemplateReferenceImage, type TemplateRouteContext } from './mapping'
import { resolveSlidePageType, type PageTypeSpec } from './page-types'
import {
  buildSlideImagePrompt,
  selectStyleReferencePath,
  type DeckContext,
  type ResolvedStylePack,
  type SlidePromptInput,
} from './style-packs'
import { cleanString } from './types'

export type VisualPlanMode = 'generate' | 'refine'

export type VisualPlanReferenceSource = 'anchor' | 'template' | 'style'

export interface VisualPlanReference {
  source: VisualPlanReferenceSource
  /** 锚点是站点存储路径；模板/风格是 public 下的样张路径。 */
  path: string
}

export interface VisualPlanSlideInput {
  pageIndex: number
  pageType: string
  role: string
  title: string
  goal: string
  visualNote?: string
  summary?: string[]
  structuredContent?: string
}

export interface VisualPlanInput {
  slide: VisualPlanSlideInput
  deckContext: DeckContext
  stylePack: ResolvedStylePack | null
  template?: TemplateRouteContext | null
  anchorImagePath?: string
  mode: VisualPlanMode
  refineInstruction?: string
  /** 整套路径一次解析的页型；缺省时按 slide 证据解析（单页入口）。 */
  pageType?: PageTypeSpec
}

export interface VisualPlan {
  pageTypeKey: string
  pageType: PageTypeSpec
  prompt: string
  /** 优先级从高到低；[0] 为生图实际使用的主参考，读失败时调用方顺延。 */
  references: VisualPlanReference[]
  primaryReference: VisualPlanReference | null
}

const REFINE_PROMPT_PREFIX = '改图要求（在保持整体风格与版式的前提下执行）：'

function toPromptSlide(slide: VisualPlanSlideInput): SlidePromptInput {
  const copy = extractCopyFromDsl(slide.structuredContent ?? '')
  return {
    role: slide.role,
    pageType: slide.pageType,
    title: copy.title || slide.title,
    goal: slide.goal,
    copyLines: copy.lines.length > 0 ? copy.lines : slide.summary ?? [],
    visualNote: slide.visualNote ?? '',
  }
}

/** 整套页型只解析一次：映射构建与逐页计划都复用这里的结果。 */
export function resolveVisualPlanPageTypes(slides: readonly VisualPlanSlideInput[]): PageTypeSpec[] {
  return slides.map((slide) => resolveSlidePageType(toPromptSlide(slide)))
}

function collectReferences(
  input: VisualPlanInput,
  slide: SlidePromptInput,
  pageType: PageTypeSpec,
): VisualPlanReference[] {
  const references: VisualPlanReference[] = []
  const anchorPath = cleanString(input.anchorImagePath, 300)
  if (anchorPath) references.push({ source: 'anchor', path: anchorPath })
  if (input.template && input.template.mapping.length > 0) {
    const templatePath = resolveTemplateReferenceImage(
      input.template.pages,
      input.template.mapping,
      input.slide.pageIndex,
    )
    if (templatePath) references.push({ source: 'template', path: templatePath })
  }
  const stylePath = selectStyleReferencePath(slide, input.stylePack, input.deckContext, pageType)
  if (stylePath) references.push({ source: 'style', path: stylePath })
  return references
}

export function buildVisualPlan(input: VisualPlanInput): VisualPlan {
  const slide = toPromptSlide(input.slide)
  const pageType = input.pageType ?? resolveSlidePageType(slide)
  const references = collectReferences(input, slide, pageType)
  const primaryReference = references[0] ?? null
  const prompt = buildSlideImagePrompt(slide, input.stylePack, {
    withStyleReferenceHint: references.length > 0,
    deckContext: input.deckContext,
    referenceMode: primaryReference?.source === 'template' ? 'template' : 'style',
    pageSpec: pageType,
  })
  const refineInstruction = input.mode === 'refine' ? cleanString(input.refineInstruction, 1000) : ''
  return {
    pageTypeKey: pageType.key,
    pageType,
    prompt: refineInstruction ? `${prompt}\n\n${REFINE_PROMPT_PREFIX}${refineInstruction}` : prompt,
    references,
    primaryReference,
  }
}

/** 每套一次的全局视觉规范：失败在接口内降级为空串并记录，调用方不再各自 catch。 */
export async function ensureVisualPlanBlueprint(
  deck: DeckRow,
  slides: DeckSlideRow[],
  deps: EngineDeps = {},
): Promise<string> {
  try {
    return await ensureDeckBlueprint(deck, slides, deps)
  } catch (error) {
    console.warn(
      '[anppt-v2][generation] 全局视觉规范生成失败，本次不带规范继续:',
      error instanceof Error ? error.message : error,
    )
    return ''
  }
}
