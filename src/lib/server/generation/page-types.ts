// 页型（page_type）注册表：把大纲 LLM 产出的自由中文 pageType 归一到有限页型，
// 每个页型带精确的中文版式指令（区域划分 / 对齐 / 允许的元素），注入生图 prompt。
// 学抖研 52 种 page_type 的思路，蒸馏为 16 种并与「易转可编辑」条款协同：
// 版式指令只规定结构，不引入艺术字、压图文字等被 §6 条款禁止的元素。
import { cleanString } from './types';

export interface PageTypeSpec {
  /** 稳定 key（测试与日志用） */
  key: string;
  /** 中文页型名，prompt 里展示用 */
  label: string;
  /** 精确版式指令，逐字进 prompt */
  layout: string;
  /** resolvePageType 模糊匹配关键词（越长越优先） */
  keywords: string[];
}

const ROLE_KEYS = new Set(['cover', 'toc', 'section', 'ending']);

export const PAGE_TYPES: readonly PageTypeSpec[] = [
  {
    key: 'cover',
    label: '封面页',
    layout:
      '主标题为绝对视觉主体，字号最大，居中或左对齐置于页面上半部；副标题一行、汇报人与日期等次要信息一小行，依次排在主标题下方；装饰元素只出现在页面边缘或底层，不得压盖标题文字。',
    keywords: ['封面'],
  },
  {
    key: 'toc',
    label: '目录页',
    layout:
      '标题「目录」或章节导航含义的标题置于顶部；3-6 个章节条目纵向等距排列，每条由「序号 + 章节名（+ 可选一句话说明）」组成，序号样式全套统一；页面一侧可配一张与主题相关的简洁配图，另一侧保持条目列表对齐。',
    keywords: ['目录', '导航', '提纲', '议程'],
  },
  {
    key: 'section',
    label: '章节过渡页',
    layout:
      '超大章节序号与章节标题为唯一视觉主体，居中或居左大号排布；只允许一行以内的过渡说明文字；大面积留白，装饰元素极少且只在边缘。',
    keywords: ['章节', '过渡', '分隔页', '篇章'],
  },
  {
    key: 'ending',
    label: '结尾页',
    layout:
      '一句核心口号或致谢语作为唯一视觉主体，居中大字排布；下方最多一行补充信息（如汇报人、团队名）；其余区域大量留白，不出现二维码或占位符。',
    keywords: ['结尾', '致谢', '感谢', '结束页', '封底'],
  },
  {
    key: 'big-number',
    label: '大数字指标页',
    layout:
      '3-4 个 KPI 指标卡片横向等宽排成一行（或 2×2 网格），每张卡片中央是超大号数字（含单位），数字下方一行指标名称、可选一行小字注释；卡片样式统一、边界分明、间距一致。',
    keywords: ['大数字', '指标', 'KPI', '数据总览', '核心数据', '成果数字'],
  },
  {
    key: 'data-chart',
    label: '数据图表页',
    layout:
      '1-2 个扁平纯色矢量图表（柱状图、饼图或折线图）为页面主体，占据中部主要区域；图表坐标轴与图例文字精简清晰；图表旁边或下方配 1-2 句结论性短句，其中关键数字可用大号强调。',
    keywords: ['数据图表', '图表', '数据分析', '统计', '趋势', '占比'],
  },
  {
    key: 'timeline',
    label: '时间轴页',
    layout:
      '一条横向（或纵向）时间轴贯穿页面，轴上 4-6 个节点等距分布；每个节点包含时间标签与一句事件短句，节点交替或同侧排布，连线与节点样式全套统一。',
    keywords: ['时间轴', '时间线', '历程', '里程碑', '规划路线', '发展阶段'],
  },
  {
    key: 'comparison',
    label: '对比分析页',
    layout:
      '左右两栏严格对称布局，每栏一个小标题加 3-4 条要点列表；两栏之间用细分隔线或居中「VS」标识区隔；两栏的配色或图标风格形成统一的对照关系。',
    keywords: ['对比', '比较', '优劣', '竞品', '前后变化', '传统与'],
  },
  {
    key: 'process',
    label: '流程步骤页',
    layout:
      '3-5 个步骤按顺序横向（或纵向）排列，步骤之间用箭头或连线串联；每步统一样式：步骤编号 + 步骤名称 + 一句简短说明；起点终点明确，整体居中对齐。',
    keywords: ['流程', '步骤', '路径', '实施计划', '工作流', '推进安排', '三阶段'],
  },
  {
    key: 'quote',
    label: '金句引用页',
    layout:
      '一句金句或引言以大字居中排布为唯一主体，可配简洁的引号装饰图形；金句下方一行小字注明出处或说话人；其余区域大量留白，不使用艺术变形字体。',
    keywords: ['金句', '引用', '引言', '语录', '口号', '理念'],
  },
  {
    key: 'image-text',
    label: '图文并列页',
    layout:
      '页面左右均分为两个区域：一侧是一张主题配图（照片或插画，图片上不得压任何文字），另一侧是小标题加 2-4 条要点列表；两区边界清晰、比例约 1:1、垂直居中对齐。',
    keywords: ['图文', '配图', '案例展示', '场景', '实拍'],
  },
  {
    key: 'case-study',
    label: '案例页',
    layout:
      '案例名称作为小标题置于上方；主体为「一张案例配图 + 2-3 条要点说明」的组合（上图下文或左图右文）；如有成果数据，用大号数字单独成行强调。',
    keywords: ['案例', '实践', '落地', '客户故事', '项目实例'],
  },
  {
    key: 'table',
    label: '表格页',
    layout:
      '一个规整表格为页面主体：表头行使用深色底白字，数据行浅色交替；全表不超过 5 列 6 行，单元格文字简短；表格居中，上下留白均匀，列宽按内容对齐。',
    keywords: ['表格', '清单', '明细', '对照表', '参数'],
  },
  {
    key: 'team',
    label: '团队介绍页',
    layout:
      '2-4 张成员卡片等宽横排或网格排列；每张卡片为「圆形头像位 + 姓名 + 职位 + 一句话介绍」的统一结构；卡片边界分明、间距一致，不得出现虚构人脸以外的占位符。',
    keywords: ['团队', '成员', '组织架构', '专家介绍', '师资'],
  },
  {
    key: 'bullets',
    label: '要点罗列页',
    layout:
      '3-5 个要点以统一卡片或列表项呈现：每项为「简洁图标 + 要点短标题 + 一行说明」；各项等高等距、纵向列表或网格排列，图标风格全套统一。',
    keywords: ['要点', '举措', '优势', '亮点', '策略', '行动', '建议', '功能', '价值'],
  },
  {
    key: 'content',
    label: '通用内容页',
    layout:
      '页面标题置于顶部标题区；正文由 2-3 个边界分明的内容块组成，块间距一致、左右对齐到同一栅格；每块一个小标题加简短正文，整体留白充足。',
    keywords: [],
  },
];

const GENERIC = PAGE_TYPES[PAGE_TYPES.length - 1];
const BY_KEY = new Map(PAGE_TYPES.map((spec) => [spec.key, spec]));

/**
 * 归一页型：role 为 cover/toc/section/ending 时角色优先；
 * 否则对自由文本 pageType 做关键词包含匹配（最长关键词胜出，同分先注册者优先），
 * 无命中兜底通用内容页。
 */
export function resolvePageType(pageType: string, role: string): PageTypeSpec {
  const roleHit = ROLE_KEYS.has(role) ? BY_KEY.get(role) : undefined;
  if (roleHit) return roleHit;
  const text = cleanString(pageType, 80);
  if (text) {
    let best: PageTypeSpec | null = null;
    let bestScore = 0;
    for (const spec of PAGE_TYPES) {
      for (const keyword of spec.keywords) {
        if (keyword.length > bestScore && text.includes(keyword)) {
          best = spec;
          bestScore = keyword.length;
        }
      }
    }
    if (best) return best;
  }
  return GENERIC;
}
