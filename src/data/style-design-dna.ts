/**
 * AnPPT 原创风格 DNA。
 *
 * 这里只记录从现有 AnPPT 样张中人工提炼的设计规则与页型参考索引，
 * 不保存第三方模板内容。稳定 stylePackId 继续兼容历史项目。
 */
export type StyleAudience = 'competition' | 'business' | 'public-sector' | 'academic' | 'general'

export type StyleDomain =
  | 'general'
  | 'technology'
  | 'medical'
  | 'education'
  | 'agriculture'
  | 'energy'
  | 'environment'
  | 'culture-tourism'
  | 'manufacturing'
  | 'finance'

export type StyleReferenceKind = 'cover' | 'toc' | 'section' | 'data' | 'process' | 'content'

export interface StyleReferencePlan {
  cover: number[]
  toc?: number[]
  section?: number[]
  data?: number[]
  process?: number[]
  content: number[]
}

export interface StyleDesignDNA {
  /** 给用户看的场景标签。 */
  scenarioLabels: string[]
  /** 无明显正文线索时，作为语境推断的弱先验。 */
  audiences: StyleAudience[]
  domains: StyleDomain[]
  palette: string[]
  grid: string
  motif: string
  imagery: string
  dataVisualization: string
  density: string
  avoid: string[]
  references: StyleReferencePlan
}

type DnaPreset = Omit<StyleDesignDNA, 'references'>

const EXECUTIVE_BLUE: DnaPreset = {
  scenarioLabels: ['企业汇报', '经营分析'],
  audiences: ['business'],
  domains: ['general'],
  palette: ['#0B2E59 深海蓝', '#2F6FB3 商务蓝', '#EAF2F8 雾蓝', '#FFFFFF 白'],
  grid: '12 栏咨询式栅格；标题区固定在顶部 12%，正文按 2-4 个对齐模块组织，左右安全边距一致。',
  motif: '细分割线、短色条、统一圆角信息卡和克制的线性图标；装饰只承担分组，不抢结论。',
  imagery: '优先真实业务现场、产品、基础设施或与正文实体直接相关的摄影；无必要不放装饰照片。',
  dataVisualization: '标题先给结论，主体只保留 1 个主图表和最多 3 个辅助指标；图例、单位和口径就近呈现。',
  density: '中高信息密度，但每页只回答一个决策问题；正文控制在 2-4 个证据组。',
  avoid: ['无关城市天际线', '握手照', '装饰性 3D 图表', '没有口径的虚构数字'],
}

const FORMAL_REPORT: DnaPreset = {
  scenarioLabels: ['工作汇报', '政企报告'],
  audiences: ['public-sector', 'business'],
  domains: ['general'],
  palette: ['#123B66 政务蓝', '#B78A3E 低饱和金', '#EEF2F5 浅灰', '#FFFFFF 白'],
  grid: '大面积白底与稳定页眉；标题、结论、依据、行动四级层次清楚，适合投屏与打印。',
  motif: '细金线、几何弧面、编号系统与正式建筑摄影裁切；单位标识区保持固定安全框。',
  imagery: '仅使用与单位、项目地点、行业设施或工作对象相关的真实场景，不臆造机关 Logo、印章或会场。',
  dataVisualization: '先呈现工作成效，再给任务拆解和下一步；图表采用蓝灰主色、金色只强调关键结论。',
  density: '中等信息密度，段落短、层级稳，避免宣传海报式大字挤占正文。',
  avoid: ['虚构红头文件', '虚构公章或单位标志', '娱乐化插画', '大面积高饱和渐变'],
}

const COMPETITION_ACADEMIC: DnaPreset = {
  scenarioLabels: ['赛事答辩', '科研评审'],
  audiences: ['competition', 'academic'],
  domains: ['technology', 'education'],
  palette: ['#083B7A 学术蓝', '#1E6BC6 科技蓝', '#D94841 证据红', '#F7F9FC 冷白'],
  grid: '评审扫读栅格：顶部一句结论，中部证据或机制图，底部来源/口径；复杂内容用编号分区而非长段落。',
  motif: '论文式细线、实验/技术示意图、编号证据卡和克制红色标注；视觉重点始终落在论证链。',
  imagery: '优先项目原型、真实实验、应用场景、工艺过程与成果证据；没有真实素材时用可解释的扁平机制图。',
  dataVisualization: '结论—证据—意义三层；所有数字必须来自页面文案，未给数据时不生成假曲线、假奖项或假专利。',
  density: '中高密度但强分层，确保评委 5 秒能读到本页结论，30 秒能找到证据。',
  avoid: ['通用 AI 大脑', '发光机器人', '无意义粒子背景', '虚构奖杯、专利证书或媒体 Logo'],
}

const CLEAN_MEDICAL: DnaPreset = {
  scenarioLabels: ['医疗汇报', '学术交流'],
  audiences: ['academic', 'public-sector'],
  domains: ['medical'],
  palette: ['#075AA6 医疗蓝', '#18A6A6 医疗青', '#EAF6F7 浅青', '#FFFFFF 白'],
  grid: '临床报告式栅格；诊疗对象、方法、结果、结论分区明确，图表与解释紧邻，不做杂志化跨栏。',
  motif: '洁净卡片、蓝青标题条、细胞/器官线稿与规范流程节点；图形准确优先于装饰。',
  imagery: '只使用与病种、器械、护理动作、实验对象直接相关且不猎奇的专业图像；保护患者隐私。',
  dataVisualization: '疗效、安全性、流程质量等指标分组呈现；保留单位、样本量和对照关系，未提供则留作定性说明。',
  density: '中等信息密度，字号清晰，医学术语与关键数字不可被背景纹理干扰。',
  avoid: ['虚构病例与疗效', '可识别患者隐私', '错误器官结构', '与病种无关的蓝色科技人像'],
}

const DARK_TECH: DnaPreset = {
  scenarioLabels: ['科技方案', '产品发布'],
  audiences: ['business', 'competition'],
  domains: ['technology'],
  palette: ['#07110B 近黑', '#78D64B 荧光绿', '#20452C 深绿', '#F4F7F5 冷白'],
  grid: '深色仪表盘栅格；核心架构或结论占主区域，指标、说明和图例沿统一边界排列。',
  motif: '低亮网格、等距模块、细发光连线与克制荧光强调；光效只用于信息路径。',
  imagery: '优先真实硬件、芯片、设备、软件界面抽象和技术架构；内容未涉及 AI 时不得强行加入机器人。',
  dataVisualization: '深底高对比扁平图表，最多一个主色高亮关键系列；避免整页都是发光小字。',
  density: '中高密度，暗底仍需保证正文大字号与足够留白。',
  avoid: ['赛博朋克人物', '随机代码雨', '无关宇宙粒子', '无法解释的全息圆环'],
}

const EDITORIAL_RED: DnaPreset = {
  scenarioLabels: ['战略咨询', '经营复盘'],
  audiences: ['business', 'public-sector'],
  domains: ['manufacturing', 'general'],
  palette: ['#8F1722 深绯红', '#D8332F 强调红', '#E8E3DE 暖灰', '#FAF8F5 米白'],
  grid: '杂志编辑式栅格但保持商务秩序；大标题与正文区严格分离，数据页回归规整多栏。',
  motif: '红色编号、黑白城市摄影、细点阵和硬朗矩形切分；红色只用于观点与风险。',
  imagery: '使用与行业、制造、组织或市场直接相关的纪实摄影，避免把城市夜景当作万能背景。',
  dataVisualization: '咨询式结论条、对比矩阵和指标拆解；关键数字红色强调，其余保持中性。',
  density: '中高密度，适合策略、问题、路径与经营复盘。',
  avoid: ['满页宣传口号', '无证据的危机感红色', '过多斜切装饰', '虚构行业数据'],
}

const SOFT_MODERN: DnaPreset = {
  scenarioLabels: ['轻商务', '项目汇报'],
  audiences: ['business', 'general'],
  domains: ['general'],
  palette: ['#3367D6 清蓝', '#7DA8F7 浅蓝', '#EEF3FF 云雾白', '#FFFFFF 白'],
  grid: '柔和大留白栅格；圆角卡片按 2×2 或 3 栏排列，主标题与数据区保持明确距离。',
  motif: '磨砂玻璃、低对比渐变、柔和光带和轻量线性图标；透明层不叠加在正文下。',
  imagery: '使用低噪、浅色、与正文对象相关的产品或空间图；没有必要时以简洁图形替代。',
  dataVisualization: '少量指标卡和简洁对比，不做重阴影、立体饼图或密集仪表盘。',
  density: '中低密度，适合阶段复盘、方案介绍和轻量发布。',
  avoid: ['低对比小字', '多层透明叠加', '漂浮玻璃球', '无意义蓝紫光晕'],
}

const ORIENTAL_MINIMAL: DnaPreset = {
  scenarioLabels: ['国风汇报', '文化项目'],
  audiences: ['business', 'public-sector'],
  domains: ['culture-tourism'],
  palette: ['#E9EEE9 月白', '#91AAA2 青瓷', '#3D4A46 墨灰', '#FFFFFF 白'],
  grid: '东方留白栅格；少量大区块、细分割线与稳定基线，正文不得竖排或使用难识别书法字。',
  motif: '青瓷曲面、淡墨城市/山形、细线框与克制留白；传统元素抽象化，不堆纹样。',
  imagery: '优先真实文化器物、地域景观、工艺细节和项目现场，图片与文字各自占独立区域。',
  dataVisualization: '低饱和单色图表，数字和结论用墨灰而非装饰性书法。',
  density: '中低密度，适合品牌、文旅、非遗和正式文化汇报。',
  avoid: ['伪书法文字', '龙凤祥云堆砌', '虚构古印章', '与主题无关的水墨山水'],
}

const ENGINEERING_LIGHT: DnaPreset = {
  scenarioLabels: ['工程方案', '能源汇报'],
  audiences: ['business', 'public-sector'],
  domains: ['energy', 'manufacturing'],
  palette: ['#F6F7F7 工程白', '#C62B2F 能源红', '#6F777D 工业灰', '#20262A 深灰'],
  grid: '工程报告栅格；指标、系统结构、里程碑和风险按清晰矩形区组织，背景保持可打印。',
  motif: '设备线稿、路径箭头、精细网格和少量红色节点；装饰不得伪装成工程数据。',
  imagery: '优先真实设备、厂区、能源设施、工艺流程和结构示意；不使用科幻城市替代行业现场。',
  dataVisualization: '容量、效率、进度、成本和风险分开呈现；时间轴与系统图优先，数据口径必须来自文案。',
  density: '中等信息密度，技术图与文字说明一一对应。',
  avoid: ['虚构设备参数', '错误工艺连接', '无关风机/光伏背景', '泛科技蓝光'],
}

const DARK_LUXURY: DnaPreset = {
  scenarioLabels: ['品牌提案', '文旅地产'],
  audiences: ['business'],
  domains: ['culture-tourism'],
  palette: ['#151311 炭黑', '#9D7750 香槟棕', '#D5B98A 暖金', '#F2ECE3 暖白'],
  grid: '高端品牌栅格；大留白与少量内容块，图片、标题和数据各自完整，不做密集仪表盘。',
  motif: '建筑光影、细金线、竖向导航和克制材质感；金色只作层级提示。',
  imagery: '使用真实空间、建筑、产品材质或服务场景，强调光影与细节，不使用泛奢侈品拼贴。',
  dataVisualization: '暖金单色图表和简洁价值链，核心指标不超过 3 个。',
  density: '低到中等密度，适合酒店、地产、文旅与品牌发布。',
  avoid: ['廉价金色渐变', '钻石皇冠图标', '过度暗化正文', '与项目无关的豪车名表'],
}

function makeDna(
  preset: DnaPreset,
  references: StyleReferencePlan,
  overrides: Partial<DnaPreset> = {},
): StyleDesignDNA {
  return {
    ...preset,
    ...overrides,
    scenarioLabels: overrides.scenarioLabels ?? preset.scenarioLabels,
    audiences: overrides.audiences ?? preset.audiences,
    domains: overrides.domains ?? preset.domains,
    palette: overrides.palette ?? preset.palette,
    avoid: overrides.avoid ?? preset.avoid,
    references,
  }
}

export const STYLE_DESIGN_DNA_BY_ID: Readonly<Record<string, StyleDesignDNA>> = {
  // 金奖测试包（开关 gold_layouts_beta 门控）：评审扫读 DNA，参考桶指向 6 张金奖版式样张
  'anppt-gold-tianxun-test-20260824': makeDna(
    COMPETITION_ACADEMIC,
    { cover: [0], toc: [1], section: [5], data: [3, 4], process: [1], content: [1, 2] },
    { scenarioLabels: ['世校赛路演', '赛事答辩'] },
  ),
  'anppt-original-innovation-20260822': makeDna(
    COMPETITION_ACADEMIC,
    { cover: [0], toc: [1], section: [2], content: [3], data: [4], process: [5] },
    {
      scenarioLabels: ['挑战杯答辩', '创新创业路演', '科研项目评审'],
      audiences: ['competition', 'academic'],
      domains: ['technology', 'education'],
      palette: ['#03152F 深海军蓝', '#126BC5 冷青蓝', '#F28A2E 琥珀橙', '#EDF5FF 冷白'],
      grid: '16:9 评审扫读栅格；左侧标题与结论占 40%，右侧证据、场景或技术结构占 60%；目录、章节、数据和流程各用独立页型，页眉与底部证据线保持统一。',
      motif: '斜切蓝色边界、精密网格、短橙色证据线、编号导航与技术路径光线；装饰始终指向问题—方案—验证—价值的论证链。',
      imagery: '优先真实高校研发、精密设备、原型测试和应用验证摄影；照片只占一个清晰区域，文字不得压在高噪图像上。',
      dataVisualization: '深色底上的单一主图表配 3-4 个证据指标，琥珀橙只标结论；所有数据必须来自页面文案并保留口径。',
      density: '中高密度但强分层，标题、证据、结论三层在投屏尺寸清楚可读。',
      avoid: ['通用 AI 大脑', '发光机器人', '城市天际线', '虚构奖项、专利、Logo 或数据', '无意义粒子海报'],
    },
  ),
  'anppt-original-skill-20260822': makeDna(
    ENGINEERING_LIGHT,
    { cover: [0], toc: [1], section: [2], content: [3], data: [4], process: [5] },
    {
      scenarioLabels: ['职业技能竞赛', '教学能力比赛', '实训成果汇报'],
      audiences: ['competition', 'academic'],
      domains: ['manufacturing', 'education'],
      palette: ['#F7F9FB 工程白', '#082D5B 深靛蓝', '#6D7E91 钢铁灰', '#F26A21 安全橙'],
      grid: '工程图纸式 12 栏栅格；标题区固定、毫米标尺与底部技术带位置统一；步骤、能力、质量和实拍证据按标准作业顺序组织。',
      motif: '斜切深蓝框、毫米刻度、机械制图线、步骤编号与安全橙定位角；不堆齿轮，图形只说明工序、精度和质量。',
      imagery: '优先真实青年选手、精密制造、机电装调、测量检验与实训现场摄影，突出手部动作、量具和工件细节。',
      dataVisualization: '质量控制线、偏差标注、一次合格率和标准执行指标使用白底蓝线与橙色阈值；单位必须紧邻数值。',
      density: '中等信息密度，动作、标准、证据与结论边界清楚，适合技能评委快速核验。',
      avoid: ['齿轮装饰堆砌', '赛博霓虹城市', '假奖杯与赛事 Logo', '虚构院校或证书', '无单位的精度数据'],
    },
  ),
  'anppt-original-career-20260822': makeDna(
    SOFT_MODERN,
    { cover: [0], toc: [1], section: [2], content: [3], data: [4], process: [5] },
    {
      scenarioLabels: ['职业规划大赛', '个人成长答辩', '学习实践复盘'],
      audiences: ['competition', 'academic'],
      domains: ['education', 'general'],
      palette: ['#F7F3EB 象牙白', '#082942 深墨蓝', '#E64B2E 暖橙红', '#C99B45 柔金'],
      grid: '编辑杂志式大留白栅格；左侧观点与证据路径为主，右侧只保留一组自然行动摄影；目录、章节和路线图沿统一坐标曲线组织。',
      motif: '细金坐标线、暖橙节点、弧形留白边界、深蓝页脚与克制摄影拼接；每个节点对应一项真实行动或证据。',
      imagery: '使用自然的学习、项目实践、岗位访谈、团队讨论与公开表达场景，人物状态真实，不使用摆拍式成功学画面。',
      dataVisualization: '能力画像、证据次数和阶段对比以细线雷达、时间路径和少量计数呈现；数据不足时用定性证据，不补造百分比。',
      density: '低到中等密度，以真诚叙事和可检查行动为主，避免鸡汤式大字占满页面。',
      avoid: ['奔跑背影与山顶剪影', '发光道路', '奖杯和掌声素材', '虚构学校 Logo', '空泛励志口号'],
    },
  ),
  cmrudmox70089a55901y20v3o: makeDna(
    EXECUTIVE_BLUE,
    { cover: [1], toc: [2], section: [3], data: [0, 4, 6, 7], process: [5], content: [0, 5, 6, 7] },
    { scenarioLabels: ['经营分析', '数据汇报'], domains: ['general', 'finance'] },
  ),
  cms5p1p5m01tl13yheatu8708: makeDna(
    FORMAL_REPORT,
    { cover: [0], toc: [1], section: [2], data: [3], process: [5], content: [3, 4, 5] },
    { palette: ['#0D3B70 深蓝', '#C99B45 雅金', '#E8EEF3 浅灰蓝', '#FFFFFF 白'] },
  ),
  cmrbxz89q001oxty8gxoa9ffq: makeDna(
    SOFT_MODERN,
    { cover: [0], section: [0], data: [1, 2, 3], process: [4], content: [1, 2, 4] },
    { scenarioLabels: ['增长复盘', '协作汇报'] },
  ),
  cms5q2vfl02qz13yh2jhgo8p3: makeDna(
    SOFT_MODERN,
    { cover: [0], section: [0], data: [1, 3, 4], process: [2], content: [1, 2, 3] },
    {
      scenarioLabels: ['管理层汇报', '极简复盘'],
      palette: ['#0A64E8 电光蓝', '#6AA5FF 浅蓝', '#F1F3F5 浅灰', '#FFFFFF 白'],
      motif: '全幅冷调摄影封面、纯白内容底、浅灰卡片和超大蓝色指标；不模仿具体品牌界面。',
    },
  ),
  cmrn8kjb002lyy1o1b81fikbr: makeDna(
    DARK_TECH,
    { cover: [1], toc: [2], section: [1], data: [0, 4, 5], process: [3], content: [3, 4, 5] },
    { scenarioLabels: ['AI/算力方案', '科技路演'] },
  ),
  cmrtyn2kl006960kpu3o6yd68: makeDna(
    EXECUTIVE_BLUE,
    { cover: [0], toc: [2], section: [4], data: [5], process: [3], content: [1, 3, 5] },
    {
      scenarioLabels: ['业务汇报', '增长计划'],
      palette: ['#F36B21 活力橙', '#F5B174 暖橙', '#F7F2EC 浅暖灰', '#FFFFFF 白'],
      motif: '暖光建筑摄影、橙色短线、编号大字与轻量白卡；整体明亮，不做促销海报。',
    },
  ),
  cmqs3gcsm0000d3ye34vdheke: makeDna(
    EDITORIAL_RED,
    { cover: [1], section: [1], data: [0, 2, 4, 5], process: [3], content: [2, 3, 4] },
    { scenarioLabels: ['战略咨询', '行业研究'] },
  ),
  cmseiyimt0qxuck7fzmcdal6m: makeDna(
    COMPETITION_ACADEMIC,
    { cover: [0], section: [0], data: [1, 3], process: [2], content: [1, 2, 4] },
    { scenarioLabels: ['科研答辩', '赛事评审'], domains: ['technology', 'education', 'medical'] },
  ),
  cmronzw9u00sg14jae48stfwf: makeDna(
    EDITORIAL_RED,
    { cover: [0], section: [1], data: [3], process: [5, 6], content: [2, 4, 5, 6] },
    {
      scenarioLabels: ['重点工作', '战略汇报'],
      palette: ['#D71920 正红', '#9E151A 深红', '#F3F0EC 米灰', '#FFFFFF 白'],
    },
  ),
  cmrn42x3n00e3t9qmt2gdrcv6: makeDna(
    EDITORIAL_RED,
    { cover: [0], toc: [2], section: [3], data: [1], process: [5], content: [1, 4, 5] },
    { scenarioLabels: ['洞察报告', '经营策略'], palette: ['#E52922 鲜红', '#111820 墨黑', '#E6E8EA 冷灰', '#FFFFFF 白'] },
  ),
  cmrk9saju00bh10zkedkn6l09: makeDna(
    SOFT_MODERN,
    { cover: [0], section: [0], data: [1], process: [2], content: [1, 2] },
    { scenarioLabels: ['项目复盘', '轻量汇报'] },
  ),
  cmrjdv6i80001kup5set1no4a: makeDna(
    DARK_TECH,
    { cover: [0], section: [1], data: [2], process: [2], content: [2] },
    {
      scenarioLabels: ['科技发布', '数字平台'],
      palette: ['#020A21 深海黑蓝', '#0077FF 亮蓝', '#2B6EFF 电蓝', '#EAF4FF 冷白'],
      motif: '蓝色光轨、环形章节门与深色平台架构；光效服务于信息路径，禁止舞台海报化。',
    },
  ),
  cmsohlood12wnd752l4f7ijxy: makeDna(
    CLEAN_MEDICAL,
    { cover: [0], toc: [1], section: [0], data: [3], process: [3], content: [2, 3, 4] },
    {
      scenarioLabels: ['护理讲课', '教学比赛'],
      audiences: ['competition', 'academic'],
      domains: ['medical', 'education'],
      palette: ['#8C6BB3 柔紫', '#5F4B8B 深紫', '#F5EFF9 浅紫', '#FFFFFF 白'],
      motif: '真实护理场景、柔紫信息卡、步骤流程与人文沟通画面；温和但保持临床专业。',
    },
  ),
  cmrxo1g2q0vxltn4r2fvx00qw: makeDna(
    CLEAN_MEDICAL,
    { cover: [0], section: [2], data: [1, 3, 4, 5], process: [4], content: [1, 3, 4, 5] },
    { scenarioLabels: ['医疗科研', '质量分析'], audiences: ['academic', 'public-sector'] },
  ),
  cmqs3gctc0003d3yei6wwxjdv: makeDna(
    DARK_LUXURY,
    { cover: [0], section: [0], data: [1, 3, 4], process: [2], content: [1, 2, 4] },
    { scenarioLabels: ['城市营销', '高端发布'] },
  ),
  cmqs3gct50002d3yetlhjw4di: makeDna(
    ENGINEERING_LIGHT,
    { cover: [0], section: [2], data: [1, 3], process: [4], content: [1, 3, 4] },
    { scenarioLabels: ['能源工程', '战略规划'] },
  ),
  cmsne1r3800d2o1xqsnu4aw9u: makeDna(
    CLEAN_MEDICAL,
    { cover: [0], section: [0], data: [1], process: [1, 2, 3], content: [1, 2, 3] },
    { scenarioLabels: ['护理技能', '临床教学'], audiences: ['competition', 'academic'], domains: ['medical', 'education'] },
  ),
  cms5jbscy000nywm197g8ls05: makeDna(
    CLEAN_MEDICAL,
    { cover: [0], toc: [2], section: [0], data: [1, 3], process: [4], content: [1, 3, 4] },
    { scenarioLabels: ['医学研发', '实验汇报'] },
  ),
  cms5j6bte03v5216o6q5kkfvh: makeDna(
    CLEAN_MEDICAL,
    { cover: [0], toc: [2], section: [0], data: [1], process: [4], content: [1, 3, 4] },
    {
      scenarioLabels: ['药物分析', '学术交流'],
      palette: ['#072C66 深藏蓝', '#0B5EA8 医疗蓝', '#E7F0F7 冷灰蓝', '#FFFFFF 白'],
    },
  ),
  cms5ip3kv03cd216omfjve2sl: makeDna(
    CLEAN_MEDICAL,
    { cover: [1], section: [1], data: [0, 2, 3], process: [2], content: [0, 2, 3] },
    { scenarioLabels: ['数字医疗', '药物研发'], domains: ['medical', 'technology'] },
  ),
  cms5ibx4802yz216ocnp7ob5h: makeDna(
    CLEAN_MEDICAL,
    { cover: [0], toc: [2], section: [0], data: [1, 3], process: [4], content: [1, 3, 4] },
    { scenarioLabels: ['公共医疗', '卫生服务'], audiences: ['public-sector', 'academic'] },
  ),
  cmr1wty4900152p2n49q1au8z: makeDna(
    DARK_TECH,
    { cover: [0], section: [0], data: [1, 2], process: [4], content: [2, 3, 4] },
    {
      scenarioLabels: ['数字增长', '任务简报'],
      palette: ['#020711 深空黑', '#1477E8 轨道蓝', '#6CA8FF 冰蓝', '#F0F6FF 冷白'],
      motif: '电影级暗场、细蓝光边界、严谨数据面板和任务分区；仅在航天主题明确时使用地球或轨道元素。',
      avoid: ['与主题无关的地球', '太空人剪影', '粒子球装饰', '难读的小号发光文字'],
    },
  ),
  cmqs3gcsw0001d3ye5wrop6g9: makeDna(
    ORIENTAL_MINIMAL,
    { cover: [0], section: [0], data: [2], process: [3], content: [1, 2, 3] },
    { scenarioLabels: ['东方品牌', '文化汇报'] },
  ),
  cmrk8asi10033v7fx2zbu1y2o: makeDna(
    EXECUTIVE_BLUE,
    { cover: [0], section: [0], data: [1, 2, 4, 5], process: [3], content: [1, 3, 4, 5] },
    {
      scenarioLabels: ['咨询报告', '市场分析'],
      palette: ['#1F5B46 墨绿', '#6F9384 灰绿', '#EEF1EF 浅灰', '#FFFFFF 白'],
      motif: '斜切墨绿几何、低饱和城市摄影、细线栏目和咨询式密集栅格。',
    },
  ),
  cmqs3gctm0004d3yedytwwyd2: makeDna(
    DARK_LUXURY,
    { cover: [0], section: [0], data: [2], process: [3], content: [1, 2, 3] },
    { scenarioLabels: ['酒店文旅', '地产提案'] },
  ),
}

export const FALLBACK_STYLE_DESIGN_DNA: StyleDesignDNA = makeDna(
  EXECUTIVE_BLUE,
  { cover: [0], section: [0], data: [0], process: [0], content: [0] },
  { scenarioLabels: ['通用汇报'], audiences: ['general'], domains: ['general'] },
)

export function getStyleDesignDna(stylePackId: string): StyleDesignDNA {
  return STYLE_DESIGN_DNA_BY_ID[stylePackId] ?? FALLBACK_STYLE_DESIGN_DNA
}
