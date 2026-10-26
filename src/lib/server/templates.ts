// 模板库（模板一版/风格一版双路线）的查询、筛选与形态判断。
// 第一阶段静态数据：数据源是 src/data/style-packs.ts 的 STYLE_PACKS + 三维打标字段，不入 DB。
// 「风格包」与「真模板」共用同一份资产：kind=template 的包在模板一版露出，
// 生成侧按 kind 分流（template 走逐页 mapping 灌内容，style 走 design-dna 风格参考）。
import {
  ALL_STYLE_PACKS,
  STYLE_PACKS,
  type StylePack,
  type StylePackDomain,
  type StylePackKind,
  type StylePackTemplatePage,
} from '../../data/style-packs'
import { getStyleDesignDna, type StyleReferenceKind } from '../../data/style-design-dna'
import { isFeatureVisible, assertFeatureVisible } from './feature-flags'
import type { PublicUser } from './auth'
import { cleanString } from './generation/types'

export type TemplateSort = 'recommended' | 'latest' | 'mostUsed'

export interface TemplateQuery {
  /** 赛事域：wvcsc（世校赛）/cicsic（双创赛，占位）/general。 */
  domain?: string
  /** 赛道（如「信息技术」），仅在赛事域内有值。 */
  track?: string
  /** 颜色维：红/橙/黄/绿/蓝/紫。 */
  color?: string
  /** 风格维：匹配包的 category 或 tags。 */
  style?: string
  /** 题材维：智慧农业/医疗健康/文旅非遗/信息AI 等。 */
  theme?: string
  /** 形态维：template=真模板，style=风格包；缺省不区分。 */
  kind?: string
  /** 排序：recommended（默认）/latest/mostUsed（预留，未接入真实用量前与推荐同序）。 */
  sort?: string
}

const DOMAIN_VALUES = new Set<StylePackDomain>(['wvcsc', 'cicsic', 'general'])

/** 判断包的路线形态；缺省 kind 一律按 style（纯风格包）处理。 */
export function resolveTemplateKind(packOrId: StylePack | string | null | undefined): StylePackKind {
  const pack = typeof packOrId === 'string' ? getTemplate(packOrId) : packOrId
  return pack?.kind === 'template' ? 'template' : 'style'
}

/** 当前用户可见的包列表：公开库 + 开关对其可见的门控测试包（服务端注入的唯一入口）。 */
export function visibleStylePacks(user: PublicUser | null | undefined): StylePack[] {
  const gated = ALL_STYLE_PACKS.filter(
    (pack) => pack.featureFlag && isFeatureVisible(pack.featureFlag, user),
  )
  return gated.length > 0 ? [...STYLE_PACKS, ...gated] : STYLE_PACKS
}

/** 挂开关的门控包对该用户是否可见可用（生成/详情硬门共用）。 */
export function isGatedPackVisible(pack: StylePack, user: PublicUser | null | undefined): boolean {
  return !pack.featureFlag || isFeatureVisible(pack.featureFlag, user)
}

/** 生成链路硬门：门控测试包对不可见用户按 404 处理（不暴露资产存在性）。 */
export function assertStylePackUsable(stylePackId: string, user: PublicUser | null | undefined): void {
  const clean = cleanString(stylePackId, 80)
  if (!clean) return
  const pack = ALL_STYLE_PACKS.find((item) => item.id === clean)
  if (pack?.featureFlag) assertFeatureVisible(pack.featureFlag, user)
}

/** 按稳定 id 或公开 slug/展示名查包（模板卡片跳转带的是 id）；门控包也能解析，可见性由调用方校验。 */
export function getTemplate(id: string): StylePack | null {
  const clean = cleanString(id, 120)
  if (!clean) return null
  return (
    ALL_STYLE_PACKS.find(
      (pack) =>
        pack.id === clean ||
        pack.slug === clean ||
        pack.name === clean ||
        (pack.legacySlugs || []).includes(clean),
    ) || null
  )
}

/** 模板库列表：先按开关注入可见包，再按形态/域/赛道/三维标签过滤，再排序。 */
export function listTemplates(query: TemplateQuery = {}, user?: PublicUser | null): StylePack[] {
  const domain = cleanString(query.domain, 40)
  const track = cleanString(query.track, 80)
  const color = cleanString(query.color, 20)
  const style = cleanString(query.style, 60)
  const theme = cleanString(query.theme, 60)
  const kind = cleanString(query.kind, 20)
  const sort = cleanString(query.sort, 20)

  let list = visibleStylePacks(user).slice()
  if (kind === 'template' || kind === 'style') {
    list = list.filter((pack) => resolveTemplateKind(pack) === kind)
  }
  if (domain && DOMAIN_VALUES.has(domain as StylePackDomain)) {
    list = list.filter((pack) => (pack.domain ?? 'general') === domain)
  }
  if (track) list = list.filter((pack) => pack.track === track)
  if (color) list = list.filter((pack) => (pack.colorTags || []).includes(color))
  if (style) list = list.filter((pack) => pack.category === style || pack.tags.includes(style))
  if (theme) list = list.filter((pack) => (pack.themeTags || []).includes(theme))

  if (sort === 'latest') {
    // 静态数据以数组内顺序为录入先后，最新 = 后录入在前。
    return list.reverse()
  }
  // recommended 与 mostUsed（预留，未接入真实用量）都先按推荐权重排序。
  return list.sort((a, b) => b.recommendationWeight - a.recommendationWeight)
}

/** 某赛事域下实际存在的赛道清单（模板一版三级导航用）。 */
export function listTemplateTracks(domain: string): string[] {
  const cleanDomain = cleanString(domain, 40)
  const tracks = STYLE_PACKS.filter((pack) => (pack.domain ?? 'general') === cleanDomain)
    .map((pack) => pack.track)
    .filter((track): track is string => Boolean(track))
  return [...new Set(tracks)]
}

/**
 * 取真模板的逐页参考图。
 * 手工标注 templatePages 时直接用（pageType 为逻辑页型 key，如 cover/design/workflow）；
 * 未标注的参考图模板按设计 DNA 的参考页索引推导，pageType 退化为参考桶名
 * （cover/toc/section/data/process/content），与页型 spec 的 referenceKind 对齐。
 */
export function getTemplatePages(pack: StylePack): StylePackTemplatePage[] {
  if (pack.templatePages && pack.templatePages.length > 0) return pack.templatePages
  const dna = getStyleDesignDna(pack.id)
  const refs = dna.references
  const buckets: Array<[StyleReferenceKind, number[] | undefined]> = [
    ['cover', refs.cover],
    ['toc', refs.toc],
    ['section', refs.section],
    ['data', refs.data],
    ['process', refs.process],
    ['content', refs.content],
  ]
  const pages: StylePackTemplatePage[] = []
  const seen = new Set<number>()
  for (const [bucket, indices] of buckets) {
    for (const index of indices || []) {
      const imageUrl = pack.previewImageUrls[index]
      if (!Number.isInteger(index) || seen.has(index) || !imageUrl) continue
      seen.add(index)
      pages.push({ pageType: bucket, imageUrl })
    }
  }
  return pages
}
