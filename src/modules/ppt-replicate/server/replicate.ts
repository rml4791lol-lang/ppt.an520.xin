// 复刻 PPT：保底图画面世界（媒介/场景/构图），只换文案与旧身份。
// 结构卡走 VLM（平台吸收，失败降级为空卡不阻塞生图）；成图走 /images/edits。
// 复刻不得走 buildSlideImagePrompt：那条链会按主题推断医院摄影/商务汇报，把壳画风冲掉。
import { chatCompletion, type EngineDeps } from '@/lib/server/engine'
import { ApiError, validationError } from '@/lib/server/http'
import { consumeRateLimit, hitRateLimit } from '@/lib/server/rate-limit'
import { getGenerationConfig, type GenerationConfig } from '@/lib/server/generation/config'
import { parseOwnedUploadRelPath, readSiteFile } from '@/lib/server/generation/storage'
import { cleanString } from '@/lib/server/generation/types'

export type ReplicateColorMode = 'new-theme' | 'follow-shell'

export interface SlideStructureCard {
  family: string
  zones: string
  slots: string
  hierarchy: string
  world: string
  forbidden: string[]
}

const STRUCTURE_EXTRACT_PROMPT = `你是幻灯片结构分析器。看这张 PPT 页图，输出一个 JSON 对象（不要解释、不要代码块外的文字），字段：
- family: 页角色，取值 cover / toc / section / cards / two-column / table / metric / process / image-led / mixed
- zones: 分区描述（标题带、主区、侧栏、页脚等相对位置，一句话）
- slots: 槽位（几张卡、几个指标、有无图表/照片/流程步，一句话）
- hierarchy: 谁最大谁最小（一句话）
- world: 画面世界（媒介+场景+构图，一句话，例如「深色静物里的笔记本界面」或「水彩森林中的七步石径」）。不要复述旧文案或品牌名。
- forbidden: 字符串数组，列出禁止带入新图的旧内容身份（旧标题原文、Logo、具体人物姓名、品牌名、旧数据）
禁止输出除 JSON 以外的任何文字。`

export type ReplicateGapPolicy = 'topic' | 'skip' | 'brief'

export interface ReplicateCopySlide {
  title: string
  content: string
  source: 'material' | 'outline' | 'topic' | 'brief' | 'skip'
}

export type ReplicateCopyMode = 'improve' | 'strict'

export function resolveReplicateCopyMode(value: unknown): ReplicateCopyMode {
  return cleanString(value, 20) === 'strict' ? 'strict' : 'improve'
}

export function resolveReplicateColorMode(value: unknown): ReplicateColorMode {
  return cleanString(value, 40) === 'new-theme' ? 'new-theme' : 'follow-shell'
}

export function parseIncomingStructure(raw: unknown): SlideStructureCard | null {
  if (raw == null) return null
  let text = ''
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    return null
  }
  if (!text || text.length > 4000) return null
  return parseStructureCard(text)
}

/** 单次拆文案最多抽这么多页结构；窗口内累计见 REPLICATE_VLM_WINDOW_MAX。超了降级空卡，不 429 文案。 */
export const REPLICATE_VLM_PER_PLAN = 24
export const REPLICATE_VLM_WINDOW_MS = 10 * 60 * 1000
export const REPLICATE_VLM_WINDOW_MAX = 48
export const REPLICATE_EXTRACT_BUDGET_MS = 90_000
export const REPLICATE_PLAN_WINDOW_MS = 10 * 60 * 1000
export const REPLICATE_PLAN_WINDOW_MAX = 30
/** 与整套文档解析上限对齐，超出在拆页/拆文案拒绝，避免先占上传与星星。 */
export const REPLICATE_MAX_PAGES = 40

export function replicatePlanRateKey(userId: string): string {
  return `replicate-plan:${userId}`
}

export function replicateVlmRateKey(userId: string): string {
  return `replicate-vlm:${userId}`
}

export function resolveReplicatePageCount(value: unknown): number {
  const pageCount = Math.floor(Number(value))
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > REPLICATE_MAX_PAGES) {
    throw validationError(`请先上传壳，页数需为 1–${REPLICATE_MAX_PAGES}`)
  }
  return pageCount
}

export function budgetReplicateExtracts(imageCount: number, remaining: number): number {
  const n = Math.max(0, Math.floor(Number(imageCount) || 0))
  const left = Math.max(0, Math.floor(Number(remaining) || 0))
  return Math.min(n, REPLICATE_VLM_PER_PLAN, left)
}

export function resolveReplicateGapPolicy(value: unknown): ReplicateGapPolicy {
  const policy = cleanString(value, 20)
  if (policy === 'skip' || policy === 'brief') return policy
  return 'topic'
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = (fence ? fence[1] : trimmed).trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function parseStructureCard(raw: string): SlideStructureCard | null {
  const parsed = extractJsonObject(raw)
  if (!parsed) return null
  const family = cleanString(parsed.family, 40)
  const zones = cleanString(parsed.zones, 400)
  const slots =
    typeof parsed.slots === 'string'
      ? cleanString(parsed.slots, 400)
      : parsed.slots && typeof parsed.slots === 'object'
        ? cleanString(JSON.stringify(parsed.slots), 400)
        : ''
  const hierarchy = cleanString(parsed.hierarchy, 400)
  const world = cleanString(parsed.world, 400)
  const forbiddenRaw = Array.isArray(parsed.forbidden) ? parsed.forbidden : []
  const forbidden = forbiddenRaw
    .map((item) => cleanString(item, 80))
    .filter(Boolean)
    .slice(0, 12)
  if (!family && !zones && !slots && !world) return null
  return { family, zones, slots, hierarchy, world, forbidden }
}

export function buildReplicateInstruction(opts: {
  structure: SlideStructureCard | null
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

/** 从壳图抽取结构卡；任何失败返回 null，调用方继续生图。 */
export async function extractSlideStructure(
  image: Buffer,
  deps: EngineDeps,
): Promise<SlideStructureCard | null> {
  try {
    const dataUrl = `data:image/png;base64,${image.toString('base64')}`
    const raw = await chatCompletion(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: STRUCTURE_EXTRACT_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      deps,
    )
    return parseStructureCard(raw)
  } catch {
    return null
  }
}

export function formatReplicatePageHints(cards: Array<SlideStructureCard | null>): string {
  return cards
    .map((card, i) => {
      const n = i + 1
      if (!card) return `第${n}页：结构未知，写短标题短句即可`
      const parts = [card.family || 'mixed', card.zones, card.slots, card.world].filter(Boolean)
      return `第${n}页：${parts.join('；')}`
    })
    .join('\n')
}

export interface ReplicateExtractResult {
  text: string
  cards: Array<SlideStructureCard | null>
  extracted: number
}

export async function extractReplicatePageHints(
  images: Buffer[],
  deps: EngineDeps = {},
  opts?: { maxCount?: number; deadlineAt?: number },
): Promise<ReplicateExtractResult> {
  const cards: Array<SlideStructureCard | null> = new Array(images.length).fill(null)
  const maxCount = opts?.maxCount == null ? images.length : Math.max(0, Math.floor(Number(opts.maxCount) || 0))
  if (images.length === 0 || maxCount <= 0) {
    return { text: formatReplicatePageHints(cards), cards, extracted: 0 }
  }
  let extracted = 0
  let started = 0
  let cursor = 0
  const workerCount = Math.min(3, images.length, maxCount)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= images.length || started >= maxCount) return
        if (opts?.deadlineAt && Date.now() >= opts.deadlineAt) return
        const image = images[index]
        // 空槽 = 该页没有壳图，跳过但不占名额：maxCount 是抽取张数上限，不是下标上限
        if (!image?.length) continue
        started += 1
        const card = await extractSlideStructure(image, deps)
        cards[index] = card
        // VLM 失败降级 null，不算已抽到结构（否则 /beautify 会谎报 N/M 页读到了结构）
        if (card) extracted += 1
      }
    }),
  )
  return { text: formatReplicatePageHints(cards), cards, extracted }
}

const COPY_PLAN_PROMPT = `你是课件编剧。要把新内容写进一份已经画好的 PPT 壳，页数 N 固定。只写每页可见文字，不设计版式。
有 PPT 大纲时：大纲是叙事脊骨。把大纲条目铺到 N 页——条目少则按主题完善补页，条目多则相邻合并。页标题优先用大纲用语，可润色但不改原意。也接受 AnPPT 大纲（【标题】或编号列表）。
材料里的事实、流程、数字必须用上；不得编造数据、人名、机构、药品名、日期。
每页只要短标题 + 能放进卡片/路径/路牌的短句；不要长段讲义，不要输出「材料未覆盖」这类元说明。
材料或大纲盖不住的页按 gapPolicy：topic 用主题下合理短句补全（source=topic）；skip 空标题空正文；brief 短标题+一句。
若提供壳页结构：第 i 页必须适配该页的槽位数、分区和画面世界，不要按培训大纲另起一种页角色。
只输出 JSON 对象：{"slides":[{"title":"","content":"换行分隔的要点","source":"material|outline|topic|brief|skip"}]}
content 不要 markdown、不要序号前缀以外的装饰。`

export function buildCopyPlanUserMessage(input: {
  topic: string
  sourceText: string
  outlineText: string
  pageCount: number
  gapPolicy: ReplicateGapPolicy
  copyMode: ReplicateCopyMode
  pageHints?: string
}): string {
  const copyModeLine =
    input.copyMode === 'strict'
      ? '文案策略：严格。尽量用材料原句和大纲原标题，少发挥。'
      : '文案策略：完善。可以改写、归纳、把材料写成更适合幻灯片的短句，并补全大纲未写清但主题需要的结构句；不得编造事实。'
  return [
    COPY_PLAN_PROMPT,
    copyModeLine,
    `主题：${input.topic}`,
    `页数 N：${input.pageCount}`,
    `gapPolicy：${input.gapPolicy}`,
    input.outlineText ? `PPT大纲：\n${input.outlineText}` : 'PPT大纲：（无，按主题与材料组织页序）',
    input.sourceText ? `官方材料：\n${input.sourceText}` : '官方材料：（无）',
    input.pageHints ? `壳页结构：\n${input.pageHints}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function firstOutlineLine(outlineText: string): string {
  for (const raw of outlineText.split(/\n/)) {
    const line = raw
      .replace(/^\s*\d+[\.、.\)］]\s*/, '')
      .replace(/^【标题】\s*/, '')
      .replace(/^#+\s*/, '')
      .trim()
    if (line) return line.slice(0, 80)
  }
  return ''
}

function gapSlide(topic: string, index: number, pageCount: number, policy: ReplicateGapPolicy): ReplicateCopySlide {
  const topicLine = cleanString(topic, 80) || '本主题'
  if (policy === 'skip') return { title: '', content: '', source: 'skip' }
  if (policy === 'brief') {
    return {
      title: topicLine,
      content: `第 ${index + 1}/${pageCount} 页概要：围绕「${topicLine}」作结构占位。`,
      source: 'brief',
    }
  }
  return {
    title: `${topicLine}（结构补全）`,
    content: `围绕「${topicLine}」作第 ${index + 1}/${pageCount} 部分的结构占位。`,
    source: 'topic',
  }
}

function normalizeCopySlide(raw: unknown, topic: string, index: number, pageCount: number, policy: ReplicateGapPolicy): ReplicateCopySlide {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return gapSlide(topic, index, pageCount, policy)
  const row = raw as Record<string, unknown>
  const title = cleanString(row.title, 120)
  const content = cleanString(row.content, 4000).replace(/\\n/g, '\n')
  const sourceRaw = cleanString(row.source, 20)
  const source: ReplicateCopySlide['source'] =
    sourceRaw === 'topic' ||
    sourceRaw === 'brief' ||
    sourceRaw === 'skip' ||
    sourceRaw === 'material' ||
    sourceRaw === 'outline'
      ? sourceRaw
      : content
        ? 'material'
        : policy === 'skip'
          ? 'skip'
          : policy
  if (!title && !content) return gapSlide(topic, index, pageCount, policy)
  return { title: title || `第 ${index + 1} 页`, content, source }
}

export function parseReplicatePlan(
  raw: string,
  pageCount: number,
  topic: string,
  gapPolicy: ReplicateGapPolicy,
): ReplicateCopySlide[] | null {
  const parsed = extractJsonObject(raw)
  const slidesRaw = parsed && Array.isArray(parsed.slides) ? parsed.slides : null
  if (!slidesRaw) return null
  const slides: ReplicateCopySlide[] = []
  for (let i = 0; i < pageCount; i += 1) {
    slides.push(normalizeCopySlide(slidesRaw[i], topic, i, pageCount, gapPolicy))
  }
  return slides
}

export async function planReplicateCopy(
  input: {
    topic: unknown
    sourceText?: unknown
    outlineText?: unknown
    pageCount: unknown
    gapPolicy?: unknown
    copyMode?: unknown
    pageHints?: unknown
  },
  deps: EngineDeps = {},
): Promise<ReplicateCopySlide[]> {
  const outlineText = cleanString(input.outlineText, 100_000)
  let topic = cleanString(input.topic, 200)
  if (!topic && outlineText) topic = firstOutlineLine(outlineText)
  if (!topic) throw validationError('请填写主题或 PPT 大纲')
  const pageCount = resolveReplicatePageCount(input.pageCount)
  const gapPolicy = resolveReplicateGapPolicy(input.gapPolicy)
  const copyMode = resolveReplicateCopyMode(input.copyMode)
  const sourceText = cleanString(input.sourceText, 100_000)
  const pageHints = cleanString(input.pageHints, 20_000)
  const raw = await chatCompletion(
    [{ role: 'user', content: buildCopyPlanUserMessage({ topic, sourceText, outlineText, pageCount, gapPolicy, copyMode, pageHints }) }],
    deps,
  )
  const slides = parseReplicatePlan(raw, pageCount, topic, gapPolicy)
  if (!slides) throw new ApiError('PLAN_FAILED', '未能根据主题拆出各页文案，请再试一次', 502, true)
  return slides
}

/**
 * 壳图路径按页下标对齐：返回定长数组（第 i 项 = 第 i 页，缺失/非法留空串）。
 * 不能过滤塌缩——服务端按下标把结构卡挂到页上，塌缩会让后面的页拿到前一页的结构。
 */
export function ownedReplicateImagePaths(raw: unknown, userId: string, pageCount: number): string[] {
  const total = Math.max(0, Math.min(pageCount, REPLICATE_MAX_PAGES))
  let list: unknown = raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      list = JSON.parse(raw) as unknown
    } catch {
      list = null
    }
  }
  const items = Array.isArray(list) ? list.slice(0, total) : []
  return Array.from({ length: total }, (_, i) => parseOwnedUploadRelPath(userId, items[i]) || '')
}

function assertReplicatePlanRate(userId: string): void {
  const rate = hitRateLimit(replicatePlanRateKey(userId), {
    windowMs: REPLICATE_PLAN_WINDOW_MS,
    max: REPLICATE_PLAN_WINDOW_MAX,
  })
  if (!rate.allowed) throw new ApiError('LLM_RATE_LIMITED', '操作过于频繁，请稍后再试', 429, true)
}

export async function runReplicatePlan(
  userId: string,
  input: {
    topic: unknown
    sourceText?: unknown
    outlineText?: unknown
    pageCount: unknown
    gapPolicy?: unknown
    copyMode?: unknown
    imagePaths?: unknown
  },
  deps: EngineDeps & { config?: GenerationConfig } = {},
): Promise<{
  slides: ReplicateCopySlide[]
  pageCount: number
  structures: Array<SlideStructureCard | null>
  structureExtracted: number
}> {
  const pageCount = resolveReplicatePageCount(input.pageCount)
  assertReplicatePlanRate(userId)
  const config = deps.config ?? getGenerationConfig()
  const maxChars = config.sourceTextMaxChars
  const paths = ownedReplicateImagePaths(input.imagePaths, userId, pageCount)
  const present = paths.map((rel, pageIndex) => ({ rel, pageIndex })).filter((entry) => entry.rel)
  const want = budgetReplicateExtracts(present.length, REPLICATE_VLM_WINDOW_MAX)
  const vlm = consumeRateLimit(replicateVlmRateKey(userId), {
    windowMs: REPLICATE_VLM_WINDOW_MS,
    max: REPLICATE_VLM_WINDOW_MAX,
    cost: want,
  })
  const extractCount = vlm.consumed
  const chosen = present.slice(0, extractCount)
  const loaded = await Promise.all(chosen.map((entry) => readSiteFile(entry.rel, config)))
  // buffers 定长按页对齐：缺口是空 Buffer，抽取时跳过，结构卡不会串页
  const buffers: Buffer[] = Array.from({ length: Math.max(pageCount, 0) }, () => Buffer.alloc(0))
  chosen.forEach((entry, i) => {
    buffers[entry.pageIndex] = loaded[i] || Buffer.alloc(0)
  })
  const extracted = await extractReplicatePageHints(buffers, deps, {
    maxCount: extractCount,
    deadlineAt: Date.now() + REPLICATE_EXTRACT_BUDGET_MS,
  })
  const slides = await planReplicateCopy(
    {
      ...input,
      sourceText: String(input.sourceText || '').slice(0, maxChars),
      outlineText: String(input.outlineText || '').slice(0, maxChars),
      pageHints: extracted.text,
    },
    deps,
  )
  return {
    slides,
    pageCount: slides.length,
    structures: slides.map((_, i) => extracted.cards[i] ?? null),
    structureExtracted: extracted.extracted,
  }
}

