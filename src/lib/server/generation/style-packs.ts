// 风格包加载、语境推断、逐页参考样张选择与生图 prompt 组装。
// 对外风格库仍以 src/data/style-packs.ts 的稳定 id 为准；设计 DNA 与参考页索引
// 由 src/data/style-design-dna.ts 维护，旧项目无需迁移。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  getStyleDesignDna,
  type StyleAudience,
  type StyleDesignDNA,
  type StyleDomain,
  type StyleReferenceKind,
} from '../../../data/style-design-dna'
import { ALL_STYLE_PACKS, STYLE_PACKS, type StylePack } from '../../../data/style-packs'
import { resolveSlidePageType, type PageTypeSpec } from './page-types'
import { getPageProtocol } from './protocols'
import { cleanString } from './types'

// 易转可编辑条款保持与现有 Codia 链兼容；字体要求沿用当前线上可稳定识别的字形。
export const EDITABLE_FRIENDLY_CLAUSE =
  '中文统一使用 Noto Sans SC（思源黑体同源字形），英文与数字统一使用 Inter；只使用清晰可读的常规无衬线字形，水平排版，不得混用装饰字体，不得使用艺术字、变形字或竖排特效；文字只出现在纯色或低噪背景上，保持高对比度，不得压盖照片或复杂纹理；标题、正文、数字、图表和照片分别占用独立且边界清楚的矩形区域，照片区域不得承载文字，装饰线不得穿过文字；单页不超过 5 个主要文本组；版式遵循清晰栅格，内容块边界分明、边缘对齐、留白充足；图表与图示使用扁平纯色矢量风格；避免多层透明叠加、复杂蒙版、过细描边和跨区斜切文字；每段文案只出现一次；不得渲染任何设计说明、坐标、字号、色值等元信息；不得出现水印、占位符或虚构 UI 元素。'

// 版面规格：把「专业排版」翻译成模型能落笔的数值。缺少这些数值时模型只能退回海报式
// 居中大标题 + 光效背景，这是站内被反馈「AI 味重」的主要成因之一。
export const SLIDE_LAYOUT_SPEC =
  '版面规格（硬性数值，不是建议）：画布 16:9；四边安全边距 6%（按短边计），任何文字不越界；基础栅格 12 栏，内容页只用 2-4 个主区块，区块间距取 24 或 32px 的整数倍；字号阶梯固定四级——页标题 40-48pt、二级小标题 22-26pt、正文 16-20pt、标注 12-14pt，同级字号全页一致；正文行高为字号的 1.6 倍，中文每行 18-26 字，行宽超了就收窄文本框而不是缩字号；一页 1 个视觉重心（最多 2 处强调）、最多 5 个文本组、2 个主色 + 1 个中性色，强调色每页不超过 2 处；背景单一实色，需要层次时用同色系三级明度；圆角统一在 4-8px 且同页一种，分隔只用 1px 细线，平光照明、无投影无高光；正文左对齐，同类元素等宽等高且边缘互相对齐；留白面积不低于全页 25% 且集中成块，标题四周至少留一个字号高度的空白；装饰只用细线、色块与编号三种，每类都要对应一处内容分组。'

export const CONTENT_RELEVANCE_CLAUSE =
  '每一张配图、图标、图表和装饰都必须服务于本页标题与正文中的具体实体或关系；若没有直接相关且可信的图像，就使用可解释的扁平结构图、流程图或留白，不得用通用 AI 大脑、发光机器人、全息圆环、随机粒子、无关城市天际线、握手照或“科技蓝光人物”填充。不得生成页面文案未提供的 Logo、二维码、奖项、证书、专利号、政策文件、公章、人名、机构名、客户、案例或数据；不得把参考图中的文字、品牌、数字、人物和主题复制进本页。'

export interface StylePackRuntimeEntry {
  id: string
  stylePrompt?: string
  palette?: string[]
  blueprint?: string
  visualKeywords?: string[]
}

export interface ResolvedStylePack {
  id: string
  name: string
  category: string
  description: string
  tags: string[]
  suitableScenarios: string[]
  /** 引擎烘焙的视觉摘要（runtime json），无则空串。 */
  stylePrompt: string
  /** runtime 色板优先，否则使用 AnPPT 设计 DNA 色板。 */
  palette: string[]
  blueprint: string
  visualKeywords: string[]
  designDna: StyleDesignDNA
  /** 已人工核验的封面样张路径。 */
  firstPreviewPath: string
  /** 同一风格包全部可用样张路径，按稳定顺序保存。 */
  previewPaths: string[]
}

export interface SlidePromptInput {
  role: string
  pageType: string
  title: string
  goal: string
  copyLines: string[]
  visualNote: string
}

export interface DeckContext {
  /** 全套总页数；>1 时才注入整套一致性段。 */
  totalPages: number
  /** 当前页序号（0 起）。 */
  pageIndex: number
  /** 所属章节名，可空。 */
  chapter?: string
  /** 整套标题，仅用于稳定识别真实使用场景，不会替代页面文案。 */
  deckTitle?: string
  /** 原始材料的有限语义信号，仅参与受众/行业推断，不直接写入生图 prompt。 */
  sourceContext?: string
  /** 全套全局视觉规范（blueprint.ts 生成、deck 级缓存），有则逐页拼接。 */
  blueprint?: string
}

export interface PresentationContext {
  audience: StyleAudience
  audienceLabel: string
  domain: StyleDomain
  domainLabel: string
  audienceDirective: string
  imageryDirective: string
  evidenceDirective: string
}

let runtimeCache: Map<string, StylePackRuntimeEntry> | null | undefined

function runtimeJsonPath(): string {
  return path.resolve(process.cwd(), 'src', 'data', 'style-packs.runtime.json')
}

function loadRuntimeMap(): Map<string, StylePackRuntimeEntry> | null {
  if (runtimeCache !== undefined) return runtimeCache
  try {
    const parsed = JSON.parse(readFileSync(runtimeJsonPath(), 'utf8'))
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.packs) ? parsed.packs : []
    const map = new Map<string, StylePackRuntimeEntry>()
    for (const item of list) {
      const id = cleanString(item?.id, 80)
      if (!id) continue
      map.set(id, {
        id,
        stylePrompt: cleanString(item?.stylePrompt, 4000),
        palette: Array.isArray(item?.palette)
          ? item.palette.map((color: unknown) => cleanString(color, 40)).filter(Boolean).slice(0, 12)
          : [],
        blueprint: cleanString(item?.blueprint, 2000),
        visualKeywords: Array.isArray(item?.visualKeywords)
          ? item.visualKeywords.map((keyword: unknown) => cleanString(keyword, 40)).filter(Boolean).slice(0, 16)
          : [],
      })
    }
    runtimeCache = map
  } catch {
    runtimeCache = null
  }
  return runtimeCache
}

/** 测试/热更新用：清掉 runtime json 缓存。 */
export function resetStylePackRuntimeCache(): void {
  runtimeCache = undefined
}

export function listStylePacks(): StylePack[] {
  return STYLE_PACKS
}

export function findStylePack(id: string): StylePack | null {
  const clean = cleanString(id, 80)
  // 服务端按全集解析：门控测试包（featureFlag）能否使用由调用方按开关另行校验。
  return ALL_STYLE_PACKS.find((pack) => pack.id === clean) || null
}

export function resolveStylePack(id: string): ResolvedStylePack | null {
  const pack = findStylePack(id)
  if (!pack) return null
  const runtime = loadRuntimeMap()?.get(pack.id)
  const designDna = getStyleDesignDna(pack.id)
  const runtimeKeywords = (runtime?.visualKeywords || []).filter(Boolean)
  return {
    id: pack.id,
    name: pack.name,
    category: pack.category,
    description: cleanString(pack.description, 1000),
    tags: pack.tags,
    suitableScenarios: pack.suitableScenarios,
    stylePrompt: runtime?.stylePrompt || '',
    palette: runtime?.palette?.length ? runtime.palette : designDna.palette,
    blueprint: runtime?.blueprint || '',
    visualKeywords: runtimeKeywords.length > 0 ? runtimeKeywords : pack.visualKeywords,
    designDna,
    firstPreviewPath: pack.previewUrl || pack.previewImageUrls[0] || '',
    previewPaths: pack.previewImageUrls,
  }
}

/** 风格指令不依赖第三方品牌名，而是使用 AnPPT 自己的设计 DNA。 */
export function styleDirective(pack: ResolvedStylePack | null): string {
  if (!pack) {
    return 'AnPPT 通用专业风格：纯净白底、稳定栅格、清楚层级、真实相关配图和克制的数据可视化。'
  }
  const dna = pack.designDna
  const parts = [
    pack.stylePrompt ? `已有视觉摘要：${pack.stylePrompt}` : '',
    pack.blueprint ? `补充视觉规范：${pack.blueprint}` : '',
    `AnPPT 原创设计规范：\n- 色板（只用这几个色值）：${pack.palette.join('、')}\n- 栅格与密度：${dna.grid} ${dna.density}\n- 图形母题：${dna.motif}\n- 配图与数据：${dna.imagery} ${dna.dataVisualization}\n- 禁止：${dna.avoid.join('、')}`,
    pack.visualKeywords.length > 0 ? `现有样张视觉关键词：${pack.visualKeywords.join('、')}` : '',
    '风格包名称仅用于用户识别；不得复刻任何具体品牌的 Logo、产品界面、专属图形或受保护版式。',
  ]
  return parts.filter(Boolean).join('\n')
}

const AUDIENCE_LABELS: Record<StyleAudience, string> = {
  competition: '高校/职业赛事评审',
  business: '企业经营与管理层汇报',
  'public-sector': '政企/学校/工作单位正式汇报',
  academic: '科研与学术评审',
  general: '通用专业演示',
}

const DOMAIN_LABELS: Record<StyleDomain, string> = {
  general: '通用',
  technology: '科技与数字化',
  medical: '医疗与生命科学',
  education: '教育与人才培养',
  agriculture: '农业与乡村振兴',
  energy: '能源与工程',
  environment: '生态环保',
  'culture-tourism': '文化、文旅与非遗',
  manufacturing: '制造与产业',
  finance: '金融与经营数据',
}

const AUDIENCE_KEYWORDS: Record<Exclude<StyleAudience, 'general'>, string[]> = {
  competition: [
    '挑战杯', '互联网+', '创新创业大赛', '双创赛', '世校赛', '职规赛', '技能大赛', '竞赛', '参赛', '评委',
    '赛道', '国赛', '省赛', '校赛', '路演答辩', '比赛作品', '获奖项目',
  ],
  business: [
    '企业', '公司', '经营', '营收', '销售', '客户', '市场', '商业模式', '盈利', '融资', '品牌', '增长', '管理层',
    '季度复盘', '年度复盘', '经营分析', '业务汇报', '战略咨询',
  ],
  'public-sector': [
    '政府', '政务', '事业单位', '党政', '国企', '工作单位', '专项行动', '工作成效', '年度重点', '政策落实',
    '民生', '公共服务', '学校行政', '领导汇报', '工作总结',
  ],
  academic: [
    '科研', '课题', '论文', '实验', '研究方法', '学术', '基金', '立项', '研究成果', '学位答辩', '教学研究', '临床研究',
  ],
}

const DOMAIN_KEYWORDS: Record<Exclude<StyleDomain, 'general'>, string[]> = {
  technology: ['人工智能', '大模型', '算法', '算力', '芯片', '软件', '数字化', '数字平台', '信息技术', '机器人', '智能装备', '物联网'],
  medical: ['医疗', '临床', '医院', '护理', '患者', '药物', '疾病', '诊疗', '生命科学', '生物医学', '健康养老', '婴幼儿托育'],
  education: ['教育', '教学', '课程', '学生', '教师', '学校', '人才培养', '实训', '产教融合', '课堂', '学习成果'],
  agriculture: ['农业', '乡村振兴', '种植', '养殖', '农产品', '农田', '农机', '粮食', '水产', '林业'],
  energy: ['能源', '电力', '电网', '光伏', '风电', '储能', '电池', '燃气', '动力', '新能源'],
  environment: ['生态', '环保', '环境治理', '碳排放', '双碳', '污染', '水治理', '固废', '生物多样性'],
  'culture-tourism': ['文化', '文旅', '旅游', '非遗', '博物馆', '景区', '酒店', '传统工艺', '文创', '地域文化'],
  manufacturing: ['制造', '工业', '工厂', '装备', '生产线', '供应链', '材料', '船舶', '交通运输', '工程建设'],
  finance: ['金融', '银行', '保险', '投资', '利润', '现金流', '成本', '预算', '收入', '经营数据'],
}

const AUDIENCE_DIRECTIVES: Record<StyleAudience, string> = {
  competition:
    '赛事评审表达：标题尽量写成可判断的结论；正文按“问题/机会—方案—证据—价值”形成论证链，让评委 5 秒看到结论、30 秒找到证据；不得用奖杯、金牌或“行业第一”代替事实。',
  business:
    '管理层表达：先给经营判断和决策含义，再给数据、原因与行动；图表要回答趋势、差距或优先级问题，避免产品宣传册式堆功能。',
  'public-sector':
    '正式工作汇报表达：按目标、举措、成效、问题、下一步组织信息，语气稳重可核验；保持打印友好，不生成红头文件、公章、单位 Logo 或空泛庆典视觉。',
  academic:
    '学术评审表达：清楚区分研究问题、方法、结果、局限与意义；实验图、机制图和数据结论一一对应，不用装饰科技图掩盖证据不足。',
  general:
    '通用专业表达：一页只回答一个问题，标题先给观点，正文用 2-3 组事实或步骤支撑。',
}

const IMAGERY_DIRECTIVES: Record<StyleDomain, string> = {
  general: '配图只选择页面文案明确提到的对象、地点、产品、行业或行为；没有直接相关素材时宁可使用结构图或留白。',
  technology: '优先真实设备、芯片、软件流程、架构模块或应用现场；只有正文明确涉及 AI/机器人时才出现相应视觉。',
  medical: '优先与病种、器械、护理动作、实验对象或公共卫生场景直接相关的专业画面，确保结构合理并保护患者隐私。',
  education: '优先真实课堂、实训、课程作品、师生协作与学习成果证据，避免通用毕业帽、奖杯和学生剪影。',
  agriculture: '优先真实作物、农田、设备、农户、供应链或实验过程，并体现具体品类和生产环节，不用泛化绿色田园背景。',
  energy: '优先真实能源设施、设备结构、工艺流程和运行数据；风机、光伏等只有正文相关时才出现。',
  environment: '优先生态对象、治理设施、监测过程和前后变化证据，不使用无关绿色地球或树叶图标充数。',
  'culture-tourism': '优先真实器物、工艺细节、地域空间、人物实践与服务场景，不拼贴无关古风符号。',
  manufacturing: '优先真实设备、厂区、工艺、材料、运输和供应链节点，技术连接必须符合正文关系。',
  finance: '以清晰图表、指标卡和业务流程为主，摄影只在确有客户或场景内容时使用。',
}

function scoreMatches(text: string, keywords: readonly string[]): number {
  let score = 0
  for (const keyword of keywords) {
    if (text.includes(keyword.toLowerCase())) score += keyword.length >= 4 ? 4 : 3
  }
  return score
}

function highestScore<T extends string>(scores: Map<T, number>, fallback: T): T {
  let winner = fallback
  let best = scores.get(fallback) ?? 0
  for (const [key, value] of scores) {
    if (value > best) {
      winner = key
      best = value
    }
  }
  return winner
}

/** 根据正文语义优先、风格包先验其次，推断受众场景与行业配图策略。 */
export function inferPresentationContext(
  slide: SlidePromptInput,
  pack: ResolvedStylePack | null,
  deck?: DeckContext,
): PresentationContext {
  const dna = pack?.designDna ?? getStyleDesignDna('')
  const text = [
    deck?.deckTitle, deck?.sourceContext, deck?.chapter,
    slide.pageType, slide.title, slide.goal, slide.visualNote, ...slide.copyLines,
  ]
    .map((part) => cleanString(part, 1200).toLowerCase())
    .join('\n')

  const audienceScores = new Map<StyleAudience, number>([
    ['competition', 0], ['business', 0], ['public-sector', 0], ['academic', 0], ['general', 0],
  ])
  for (const audience of dna.audiences) audienceScores.set(audience, (audienceScores.get(audience) ?? 0) + 1)
  for (const [audience, keywords] of Object.entries(AUDIENCE_KEYWORDS) as Array<[
    Exclude<StyleAudience, 'general'>,
    string[],
  ]>) {
    audienceScores.set(audience, (audienceScores.get(audience) ?? 0) + scoreMatches(text, keywords))
  }
  const fallbackAudience = dna.audiences[0] ?? 'general'
  const audience = highestScore(audienceScores, fallbackAudience)

  const domainScores = new Map<StyleDomain, number>([
    ['technology', 0], ['medical', 0], ['education', 0], ['agriculture', 0], ['energy', 0],
    ['environment', 0], ['culture-tourism', 0], ['manufacturing', 0], ['finance', 0], ['general', 0],
  ])
  for (const domain of dna.domains) domainScores.set(domain, (domainScores.get(domain) ?? 0) + 1)
  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS) as Array<[
    Exclude<StyleDomain, 'general'>,
    string[],
  ]>) {
    domainScores.set(domain, (domainScores.get(domain) ?? 0) + scoreMatches(text, keywords))
  }
  const fallbackDomain = dna.domains[0] ?? 'general'
  const domain = highestScore(domainScores, fallbackDomain)
  const hasNumbers = /\d/.test(text)

  return {
    audience,
    audienceLabel: AUDIENCE_LABELS[audience],
    domain,
    domainLabel: DOMAIN_LABELS[domain],
    audienceDirective: AUDIENCE_DIRECTIVES[audience],
    imageryDirective: IMAGERY_DIRECTIVES[domain],
    evidenceDirective: hasNumbers
      ? '页面含数字：只能逐字使用页面文案已有数字、单位、时间与比较关系；无法确认口径时不要补造图例、样本量或增长率。'
      : '页面未提供可核验数字：使用定性结构、流程或关系表达，不得自行生成百分比、金额、排名、样本量或增长曲线。',
  }
}

function pageSpecForSlide(slide: SlidePromptInput): PageTypeSpec {
  return resolveSlidePageType(slide)
}

function referenceCandidates(dna: StyleDesignDNA, kind: StyleReferenceKind): number[] {
  const refs = dna.references
  if (kind === 'cover') return refs.cover
  if (kind === 'toc') return refs.toc?.length ? refs.toc : refs.content
  if (kind === 'section') return refs.section?.length ? refs.section : refs.cover
  if (kind === 'data') return refs.data?.length ? refs.data : refs.content
  if (kind === 'process') return refs.process?.length ? refs.process : refs.content
  return refs.content
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 为每一页确定性选择同风格、尽量同页型的参考样张。 */
export function selectStyleReferencePath(
  slide: SlidePromptInput,
  pack: ResolvedStylePack | null,
  deck?: DeckContext,
  /** 已解析页型（视觉计划一次解析后复用）；缺省按 slide 证据解析。 */
  pageSpec?: PageTypeSpec,
): string | null {
  if (!pack || pack.previewPaths.length === 0) return null
  const spec = pageSpec ?? pageSpecForSlide(slide)
  const candidates = referenceCandidates(pack.designDna, spec.referenceKind)
    .filter((index) => Number.isInteger(index) && index >= 0 && Boolean(pack.previewPaths[index]))
  if (candidates.length === 0) return pack.firstPreviewPath || pack.previewPaths[0] || null
  const seed = `${pack.id}:${spec.key}:${deck?.pageIndex ?? 0}:${slide.title}`
  return pack.previewPaths[candidates[stableHash(seed) % candidates.length]] || pack.firstPreviewPath || null
}

/** 读取 public 下的风格参考图并转为 data URL；调用方负责先选择页型匹配路径。 */
export function loadStyleReferenceDataUrl(
  pack: ResolvedStylePack | null,
  previewPath: string | null = pack?.firstPreviewPath || null,
): string | null {
  if (!pack || !previewPath) return null
  try {
    const rel = previewPath.replace(/^\/+/, '')
    const publicRoot = path.resolve(process.cwd(), 'public')
    const absPath = path.resolve(publicRoot, rel)
    if (!absPath.startsWith(`${publicRoot}${path.sep}`)) return null
    const buffer = readFileSync(absPath)
    if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return null
    const extension = path.extname(absPath).toLowerCase()
    const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 八段式提示词：AnPPT 生图提示词的固定段落契约。
 * 段数、段序与每段职责都是对外创新点的组成口径，不得随意增删；上下文不适用的段拼接时跳过，
 * 但段位始终存在——契约测试与排查“提示词为什么这样写”都以这八段为准。
 */
export type SlidePromptStageKey =
  | 'context-task'
  | 'deck-consistency'
  | 'page-role-protocol'
  | 'page-copy'
  | 'layout-imagery'
  | 'style-dna'
  | 'content-fidelity'
  | 'editable-friendly'

export interface SlidePromptStageDef {
  key: SlidePromptStageKey
  /** 段序（1 起），与拼接顺序一致。 */
  order: number
  /** 对外展示名。 */
  label: string
  /** 这一段负责解决的问题。 */
  focus: string
}

export interface SlidePromptStage extends SlidePromptStageDef {
  /** 该段文本；当前上下文不适用时为空串（拼接时跳过）。 */
  text: string
}

export const SLIDE_PROMPT_STAGE_DEFS: readonly SlidePromptStageDef[] = [
  { key: 'context-task', order: 1, label: '任务与语境', focus: '整页成图任务 + 真实受众、行业与证据口径' },
  { key: 'deck-consistency', order: 2, label: '整套一致性', focus: '全套页码章节、统一栅格与全局视觉规范' },
  { key: 'page-role-protocol', order: 3, label: '页面角色与页型协议', focus: '该页型的信息任务、构图版式、配图基因与禁忌' },
  { key: 'page-copy', order: 4, label: '页面文案与防幻觉', focus: '标题、表达目标与逐字文案，且只允许出现给定文字' },
  { key: 'layout-imagery', order: 5, label: '版式与配图建议', focus: '用户版式意图，只能在前四段框架内执行' },
  { key: 'style-dna', order: 6, label: '风格 DNA 与参考样张', focus: '色板、栅格与图形母题；样张只取风格不取内容' },
  { key: 'content-fidelity', order: 7, label: '内容真实性硬约束', focus: '配图、数据、机构与品牌一律不得虚构' },
  { key: 'editable-friendly', order: 8, label: '易转可编辑条款', focus: '分区与字形干净，能被下游转可编辑链路还原' },
]

export interface SlidePromptOptions {
  withStyleReferenceHint?: boolean
  deckContext?: DeckContext
  referenceMode?: 'style' | 'template'
  /** 已解析页型（视觉计划一次解析后复用）；缺省按 slide 证据解析。 */
  pageSpec?: PageTypeSpec
}

/** 按八段式契约组装生图提示词（段序即拼接序，空段跳过）。 */
export function buildSlideImagePromptStages(
  slide: SlidePromptInput,
  pack: ResolvedStylePack | null,
  opts: SlidePromptOptions = {},
): SlidePromptStage[] {
  const copy = slide.copyLines.map((line) => cleanString(line, 1000)).filter(Boolean)
  const pageSpec = opts.pageSpec ?? pageSpecForSlide(slide)
  const deck = opts.deckContext
  const context = inferPresentationContext(slide, pack, deck)
  const texts: Record<SlidePromptStageKey, string> = {
    'context-task': [
      '为一张 16:9 专业演示 PPT 幻灯片生成完整的最终视觉图（整页一张图，含全部排版与文字）。产物是能直接投屏与打印的页面版式，不是海报：层级由字号、位置与留白决定，背景用单一实色，层次用同色系明度区分，装饰只用细线与色块。',
      SLIDE_LAYOUT_SPEC,
      '避免这些一眼假的画法：居中大标题 + 顶部小标签 + 三张等宽卡的三段式、所有卡片同半径圆角配软投影、每段标题配 emoji、玻璃拟态与弥散光晕、无意义粒子与科技光带、每页一模一样的装饰页眉、纯黑正文配纯白底。',
      '允许人做的痕迹：真实摄影、手写批注、轻微不对称与实物纹理，主观表达优先于机械对称。',
      `主题语境：${context.audienceLabel} · ${context.domainLabel}\n${context.audienceDirective}\n${context.imageryDirective}\n${context.evidenceDirective}`,
    ].join('\n\n'),
    'deck-consistency': [
      deck && deck.totalPages > 1
        ? `整套一致性要求：本页是全套 ${deck.totalPages} 页中的第 ${deck.pageIndex + 1} 页${deck.chapter ? `，属于「${deck.chapter}」章节` : ''}；全套页面必须保持完全一致的栅格系统、字号层级、配色方案、页眉页脚与页码位置、装饰元素语言，仅按页型变化版式。内容页页眉必须使用较小字号、固定高度且不得抢过正文标题；未上传真实 Logo 时页眉标识区保持空白，禁止从参考图复制或重新生成 Logo。`
        : '',
      deck?.blueprint
        ? `全套全局视觉规范（每一页都必须严格遵守，仅按页型分工调整版式）：\n${deck.blueprint}`
        : '',
    ].filter(Boolean).join('\n\n'),
    'page-role-protocol': [
      `页面角色：${slide.role || 'content'}${slide.pageType ? `（大纲标注页型：${slide.pageType}）` : ''}`,
      getPageProtocol(pageSpec),
    ].filter(Boolean).join('\n\n'),
    'page-copy': [
      slide.title ? `页面标题：${slide.title}` : '',
      slide.goal ? `本页表达目标：${slide.goal}` : '',
      copy.length > 0
        ? `页面文案（必须逐字完整呈现，不得增删、不得改写；同一句只出现一次）：\n${copy.map((line) => `- ${line}`).join('\n')}`
        : '',
      copy.length > 0
        ? '防幻觉约束：本页只允许出现上方「页面标题」与「页面文案」给出的文字；参考样张中的文字块、数字、Logo 一律视为版式占位，不得带入本页。'
        : '',
    ].filter(Boolean).join('\n\n'),
    'layout-imagery': slide.visualNote ? `版式/配图建议（只能在上述信息任务与页型框架内执行）：${slide.visualNote}` : '',
    'style-dna': [
      `风格要求：\n${styleDirective(pack)}`,
      opts.withStyleReferenceHint
        ? opts.referenceMode === 'template'
          ? '随附一张真模板参考页：尽量复刻它的版式骨架——大色块划分、标题区位置、分栏比例、卡片与容器形态、装饰密度——并把本页文案准确填入对应区域；参考页中的人物、场景、数字、Logo 与具体文字一律视为版式占位，严禁带入本页。'
          : '随附一张同风格参考样张。只提取它的色板、栅格、卡片边界、标题层级和装饰母题；必须按本页角色重新组织版式，不得把封面布局硬套到内容页，也不得复制参考图的文字、Logo、数字、人物、图表数据、品牌和具体主题。'
        : '',
    ].filter(Boolean).join('\n\n'),
    'content-fidelity': `内容真实性与相关性硬约束（必须严格遵守）：${CONTENT_RELEVANCE_CLAUSE}`,
    'editable-friendly': `易转可编辑排版条款（必须严格遵守）：${EDITABLE_FRIENDLY_CLAUSE}`,
  }
  return SLIDE_PROMPT_STAGE_DEFS.map((def) => ({ ...def, text: texts[def.key] }))
}

/** 生图 prompt 文本 = 八段式结构按段序拼接（空段跳过）。 */
export function buildSlideImagePrompt(
  slide: SlidePromptInput,
  pack: ResolvedStylePack | null,
  opts: SlidePromptOptions = {},
): string {
  return buildSlideImagePromptStages(slide, pack, opts)
    .map((stage) => stage.text)
    .filter(Boolean)
    .join('\n\n')
}
