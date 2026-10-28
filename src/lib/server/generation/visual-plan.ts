// 每页视觉计划：整套、单页与复刻的页型、提示词与参考图的唯一决策点。
// 页型只解析一次，模板映射与提示词都读同一个键；参考图按锚点 > 模板样张 > 风格样张
// 排成完整候选（调用方按序取第一个可读的，不在某个分支里悄悄丢图）。
// 复刻是计划的第三个 mode：以壳图的画面世界为约束装配提示词，不跑整套主题推断。
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

export type VisualPlanMode = 'generate' | 'refine' | 'replicate'

export type ReplicateColorMode = 'follow-shell' | 'new-theme'

/** 壳页结构卡（复刻计划模式的页型证据与画面世界约束；VLM/客户端回传，可空卡）。 */
export interface ReplicateStructureCard {
  family: string
  zones: string
  slots: string
  hierarchy: string
  world: string
  forbidden: string[]
}

export interface VisualPlanReplicateInput {
  structure: ReplicateStructureCard | null
  colorMode: ReplicateColorMode
}

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
  /** 复刻模式必填：壳页结构卡与配色策略。 */
  replicate?: VisualPlanReplicateInput
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

/**
 * 改图意图（微调 / 图上改字 / 涂抹 / 融合）：调用方只传结构化意图与用户要求，
 * 模板话术与灾备降级说明都归本模块——四处手写文案曾各自漂移。
 */
export type RefineIntent =
  | { kind: 'instruction'; instruction: string }
  | { kind: 'edit-text'; instruction: string }
  | { kind: 'erase' }
  | { kind: 'fuse'; templateName: string; visualKeywords: readonly string[]; instruction?: string }

export interface RefineCopy {
  /** 交给生图服务的改图指令（不含 REFINE_PROMPT_PREFIX，前缀由 buildVisualPlan 统一加） */
  instruction: string
  /** 灾备渠道丢附加图时拼进 prompt 的降级说明（只有带附加图的意图需要） */
  extraNote?: string
}

const ERASE_INSTRUCTION =
  '第二张图是第一张的标记版，红色涂抹区是要擦除的内容；移除该区内容并用与周围一致的底色/留白自然填充，其余元素、文字、版式、配色全部保持不变，图上不得出现红色标记。'
const ERASE_DEGRADE_NOTE =
  '（附加的红色涂抹标记图未能传递到生图服务：请依据常识判断图上最可能被用户要求移除的多余元素并移除，用与周围一致的底色/留白自然填充，其余元素、文字、版式、配色全部保持不变。）'

/** 改图意图 → 生图指令与降级说明：模板话术唯一来源。 */
export function buildRefineCopy(intent: RefineIntent): RefineCopy {
  switch (intent.kind) {
    case 'instruction':
      return { instruction: intent.instruction }
    case 'edit-text':
      return { instruction: `图上改字：${intent.instruction}。只改指定文字，其余元素、版式、配色全部保持不变。` }
    case 'erase':
      return { instruction: ERASE_INSTRUCTION, extraNote: ERASE_DEGRADE_NOTE }
    case 'fuse': {
      const extra = intent.instruction ?? ''
      const keywords = intent.visualKeywords.slice(0, 8).join('、') || '同色系商务模板'
      return {
        instruction: `把第一张图的版式骨架保留，视觉风格向第二张参考图靠拢融合，文字内容保持不变。${extra ? `补充要求：${extra}` : ''}`,
        extraNote: `（本次未附带融合参考图：请把本页视觉风格向「${intent.templateName.slice(0, 40)}」靠拢——${keywords}——版式骨架与文字内容保持不变。）`,
      }
    }
  }
}

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

/** 复刻合同：换文案、保画面。结构卡与配色策略只由计划模式装配。 */
export function buildReplicateInstruction(opts: {
  structure: ReplicateStructureCard | null
  colorMode: ReplicateColorMode
}): string {
  const colorLine =
    opts.colorMode === 'follow-shell'
      ? '配色策略：跟随底图的主辅色、对比度、色温与材质；媒介和场景不得改种。'
      : '配色策略：只换色板，媒介、场景、构图、道具与装饰密度仍跟底图。'
  const structureLines = opts.structure
    ? [
        `结构卡（槽位与分区必须对齐）：`,
        `- 页角色：${opts.structure.family || 'mixed'}`,
        `- 分区：${opts.structure.zones || '从底图归纳'}`,
        `- 槽位：${opts.structure.slots || '从底图归纳'}`,
        `- 层级：${opts.structure.hierarchy || '标题明显大于正文'}`,
        opts.structure.world ? `- 画面世界：${opts.structure.world}` : '- 画面世界：从底图归纳媒介与场景',
        opts.structure.forbidden.length > 0
          ? `- 禁止带入的旧身份：${opts.structure.forbidden.join('、')}`
          : '- 禁止带入：底图上的旧文字、Logo、人物姓名、品牌名、旧数据',
      ]
    : [
        '未能解析结构卡时，仍从底图自行归纳分区、槽位数、媒介与场景。',
        '禁止带入底图上的旧文字、Logo、人物姓名、品牌名、旧数据。',
      ]
  return [
    '复刻合同：换文案、保画面。必须保留底图的媒介（水彩/手绘/摄影/界面嵌在场景里等）、场景、构图、道具、光影和装饰密度。',
    '禁止改成白底商务信息图、医院实拍或扁平图标页，除非底图本身就是那种。禁止只抽取「几张卡」然后另起炉灶。',
    '把底图上所有可见旧文字换成上方给定文案；旧产品名、旧界面文案、Logo 与旧数据不得保留。可见文字必须逐字来自给定文案。',
    ...structureLines,
    colorLine,
  ].join('\n')
}

/** 复刻专用文案段：不注入风格包与主题配图策略。 */
export function buildReplicateCopyPrompt(input: { title: string; content: string }): string {
  const copy = input.content
    .split(/\n+/)
    .map((line) => cleanString(line, 1000))
    .filter(Boolean)
  return [
    '在已上传的底图上改图，输出一张完整的 16:9 幻灯片终图。',
    input.title ? `页面标题：${input.title}` : '',
    copy.length > 0
      ? `页面文案（必须逐字完整呈现，不得增删、不得改写）：\n${copy.map((line) => `- ${line}`).join('\n')}`
      : '',
    '本页只允许出现以上标题与文案中的文字；底图旧字全部替换，不得另写标语。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function buildReplicatePlan(input: VisualPlanInput, slide: SlidePromptInput): VisualPlan {
  const replicate = input.replicate ?? { structure: null, colorMode: 'follow-shell' as const }
  const pageType =
    input.pageType ??
    resolveSlidePageType({
      pageType: replicate.structure?.family ?? '',
      title: slide.title,
      goal: slide.goal,
      role: slide.role,
    })
  const prompt = [
    buildReplicateCopyPrompt({ title: slide.title, content: slide.copyLines.join('\n') }),
    buildReplicateInstruction({ structure: replicate.structure, colorMode: replicate.colorMode }),
  ].join('\n\n')
  // 壳图由调用方作为改图底图传入；复刻不额外取风格/模板参考，避免第二套画面世界
  return { pageTypeKey: pageType.key, pageType, prompt, references: [], primaryReference: null }
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
  if (input.mode === 'replicate') return buildReplicatePlan(input, slide)
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

export interface VisualPlanReferenceLoaders {
  /** 站点存储路径（风格锚点）：读失败返回 null。 */
  readAnchor: (path: string) => Promise<Buffer | null>
  /** public 样张（模板/风格）：读失败返回 null。 */
  readPublic: (path: string) => string | null
}

/**
 * 按计划优先级读取参考图：返回第一个可读候选的 data URL，全部不可读返回 null。
 * 读取失败的候选顺延到下一个，不在某个分支里静默丢掉整条参考。
 */
export async function resolveVisualPlanReference(
  plan: VisualPlan,
  loaders: VisualPlanReferenceLoaders,
): Promise<string | null> {
  for (const reference of plan.references) {
    const dataUrl = await loadVisualPlanReference(reference, loaders)
    if (dataUrl) return dataUrl
  }
  return null
}

/** 单个候选的读取：锚点转 data URL，模板/风格样张由调用方读 public 文件。 */
export async function loadVisualPlanReference(
  reference: VisualPlanReference,
  loaders: VisualPlanReferenceLoaders,
): Promise<string | null> {
  try {
    if (reference.source === 'anchor') {
      const anchor = await loaders.readAnchor(reference.path)
      return anchor ? `data:image/png;base64,${anchor.toString('base64')}` : null
    }
    return loaders.readPublic(reference.path)
  } catch {
    // 读失败顺延：参考图不是生成前置条件
    return null
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
