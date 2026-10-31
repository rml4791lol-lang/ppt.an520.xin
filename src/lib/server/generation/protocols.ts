// 页型协议：把 page-types.ts 的「信息任务 + 版式指令」升级为分层专业规则
// （文字忠实 / 信息任务 / 构图版式 / 配图基因 / 禁忌），按页型注入生图 prompt。
// 规则文案由 AnPPT 自行撰写维护，仅借鉴行业通行的分层思路，不含任何竞品原文。
import type { PageTypeSpec } from './page-types'

const TEXT_FIDELITY =
  '本页所有可见文字必须逐字来自给定的页面标题与页面文案，不改写、不增删、不合并、不翻译，同一句只出现一次；严禁虚构标语、数字、单位、人名、机构名、Logo、二维码或任何装饰性字符。'

interface ProtocolGroup {
  /** 配图基因：这一组页型允许用什么视觉素材。 */
  gene: string
  /** 版式坐标：这一组页型的区块占比与密度，给模型可落笔的数值。 */
  layout: string
  /** 禁忌：这一组页型的硬性禁区。 */
  taboo: string
}

const COVER_PROTOCOL: ProtocolGroup = {
  gene: '用与主题直接相关的概念化主视觉建立第一印象：抽象联觉图形、象征性构筑物或真实场景特写均可，但配图只服务主题氛围，不承载正文信息。',
  layout: '标题占左侧 60% 或上方 50%，主标题为全页最大字号（等效 ≥56pt）；文本组不超过 3 个；底部 10% 只放机构与日期。',
  taboo: '严禁出现数据图表与正文级要点列表；严禁把目录、结论或汇报人长信息挤上封面；装饰元素不得压盖标题。',
}

const STRUCTURE_PROTOCOL: ProtocolGroup = {
  gene: '以版式自身为视觉主体（超大序号、章节名、收束语与留白），装饰只出现在页面边缘；如需配图，仅用与章节主题直接相关的一张简洁图。',
  layout: '章节序号与章节名构成唯一视觉重心，留白不低于 50%；除序号外最多 2 行文字。',
  taboo: '严禁新增正文论证信息；严禁虚构 Logo、二维码、联系方式；过渡说明不得超过一行。',
}

const DATA_PROTOCOL: ProtocolGroup = {
  gene: '图表是唯一主体视觉：图表类型必须匹配数据关系（趋势用折线、构成用堆叠或饼图、对比用柱状、排名用条形）；无数据时使用结构示意图或指标卡。',
  layout: '结论句在顶部 15% 内先给出；主图表占 55%-70% 面积；图例、单位与注释紧贴图表，不跨区摆放；同页最多 1 个主图表 + 3 个指标。',
  taboo: '严禁虚构坐标刻度、样本量、增长率、图例与来源；严禁 3D 扭曲、透视变形的图表；未给口径的数字不得放大强调。',
}

const PROCESS_PROTOCOL: ProtocolGroup = {
  gene: '流程线与步骤框为主体，箭头必须表示真实流向；每步可配与步骤内容对应的统一风格图标。',
  layout: '步骤不超过 6 步，单步容器等宽等高、边缘对齐；箭头只连接真实先后关系；编号与图标各占固定一列。',
  taboo: '严禁无流向关系的图标卡堆砌；步骤顺序、命名必须与页面文案一致，不得自行增删步骤。',
}

const CONTENT_PROTOCOL: ProtocolGroup = {
  gene: '配图必须对应页面文案中的具体实体、对象或关系；没有可信素材时使用可解释的扁平结构图、关系图或留白。',
  layout: '标题区固定占顶部 12%-15%；正文分 2-4 个区块，每区块一个标题 + 1-3 行正文，块间留白不小于一个行高。',
  taboo: '严禁通用万能配图（AI 大脑、发光机器人、全息圆环、无关城市天际线、握手照）；严禁大段文字无层级平铺成墙。',
}

const STRUCTURE_KEYS = new Set(['toc', 'section', 'ending'])

function groupFor(spec: PageTypeSpec): ProtocolGroup {
  if (spec.key === 'cover') return COVER_PROTOCOL
  if (STRUCTURE_KEYS.has(spec.key)) return STRUCTURE_PROTOCOL
  if (spec.referenceKind === 'data') return DATA_PROTOCOL
  if (spec.referenceKind === 'process') return PROCESS_PROTOCOL
  return CONTENT_PROTOCOL
}

/** 单个页型的分层协议文本，整体作为一个段落进入生图 prompt。 */
export function getPageProtocol(spec: PageTypeSpec): string {
  const group = groupFor(spec)
  return [
    `页型协议 · ${spec.label}（必须逐条遵守）：`,
    `1. 文字忠实：${TEXT_FIDELITY}`,
    `2. 信息任务：${spec.informationGoal}`,
    `3. 构图与版式：${spec.layout} 本组版式坐标：${group.layout}`,
    `4. 配图基因：${group.gene}`,
    `5. 禁忌：${group.taboo}`,
  ].join('\n')
}
