// 页型（page_type）注册表：把大纲 LLM 或旧项目的自由文本页型归一到有限页型，
// 再将“信息任务 + 布局约束 + 参考样张类别”注入生图 prompt。
// 方法借鉴赛事模板站按页型匹配的思路，但布局规则与视觉资产均为 AnPPT 自己维护。
// 通用页型之外另含世校赛骨架页型（design/workflow/skill/outcomes/value），与通用页型共用同一套归一逻辑。
import type { StyleReferenceKind } from '../../../data/style-design-dna'
import { cleanString } from './types'

export interface PageTypeSpec {
  /** 稳定 key（测试、日志与参考图选择用）。 */
  key: string
  /** 中文页型名，prompt 里展示用。 */
  label: string
  /** 本页应完成的信息任务。 */
  informationGoal: string
  /** 精确版式指令，逐字进入 prompt。 */
  layout: string
  /** 该页型应选哪一类同风格参考样张。 */
  referenceKind: StyleReferenceKind
  /** resolvePageType 模糊匹配关键词（越长越优先）。 */
  keywords: string[]
}

const ROLE_KEYS = new Set(['cover', 'toc', 'section', 'ending'])

export const PAGE_TYPES: readonly PageTypeSpec[] = [
  {
    key: 'cover',
    label: '封面页',
    informationGoal: '用一个可信、聚焦的视觉建立整套主题与场景，不承载正文论证。',
    layout:
      '主标题为绝对视觉主体，字号最大，居中或左对齐置于页面上半部；副标题一行、汇报人与日期等次要信息一小行，依次排在主标题下方；装饰元素只出现在页面边缘或底层，不得压盖标题文字。',
    referenceKind: 'cover',
    keywords: ['bp_cover', 'title_page', 'title', '封面页', '标题页', '首页', '封面', 'cover'],
  },
  {
    key: 'toc',
    label: '目录页',
    informationGoal: '让观众在数秒内理解全套叙事顺序和章节关系。',
    layout:
      '标题「目录」或章节导航含义的标题置于顶部；3-6 个章节条目纵向等距排列，每条由「序号 + 章节名（+ 可选一句话说明）」组成，序号样式全套统一；页面一侧可配一张与主题直接相关的简洁配图，另一侧保持条目列表对齐。',
    referenceKind: 'toc',
    keywords: ['contents', '目录页', '章节导航', '目录', '导航', '提纲', '议程', 'toc'],
  },
  {
    key: 'section',
    label: '章节过渡页',
    informationGoal: '清楚切换章节，并提示下一部分的核心问题。',
    layout:
      '超大章节序号与章节标题为唯一视觉主体，居中或居左大号排布；只允许一行以内的过渡说明文字；大面积留白，装饰元素极少且只在边缘。',
    referenceKind: 'section',
    keywords: ['section_page', '章节过渡', '章节页', '分隔页', '过渡页', '篇章', '章节', 'section'],
  },
  {
    key: 'ending',
    label: '结尾页',
    informationGoal: '用一句可记忆的结论、行动号召或致谢完成收束。',
    layout:
      '一句核心口号、结论或致谢语作为唯一视觉主体，居中大字排布；下方最多一行补充信息（如汇报人、团队名）；其余区域大量留白，不出现二维码、联系方式占位符或虚构 Logo。',
    referenceKind: 'section',
    keywords: ['bp_ending', 'closing', '结束页', '结语展望', '结语', '展望', '愿景', '致谢', '感谢', '结尾', '封底', 'ending'],
  },
  {
    key: 'project-background',
    label: '项目背景页',
    informationGoal: '说明项目为什么在此时、此场景下值得做，并建立事实起点。',
    layout:
      '顶部用一句结论概括背景；主体采用「外部环境/对象现状/触发事件」三块结构，或左侧场景证据、右侧背景归纳；如文案含时间、地点、对象或来源，应就近标注，不得用泛化大图替代事实。',
    referenceKind: 'content',
    keywords: ['bp_background', 'project_background', 'background', '项目背景', '背景介绍', '项目缘起', '创始背景', '背景概况'],
  },
  {
    key: 'policy-context',
    label: '政策依据页',
    informationGoal: '呈现与项目直接相关的政策依据、要求及其带来的机会或约束。',
    layout:
      '采用「政策/要求/与本项目关系」的 2-4 条证据卡，政策名称和原文要点置于上层，项目响应置于下层；仅呈现页面文案中明确提供的政策名称、年份和表述，禁止臆造红头文件、公章或发文单位。',
    referenceKind: 'content',
    keywords: ['bp_policy', 'policy_context', 'policy', '政策背景', '政策依据', '政策支持', '政策环境', '政策机遇'],
  },
  {
    key: 'pain-analysis',
    label: '痛点分析页',
    informationGoal: '把表象问题、受影响对象和根因连接成可验证的问题链。',
    layout:
      '用 2-4 个痛点模块呈现「现象/证据 → 根因 → 后果」，顶部先给总判断；可采用鱼骨、因果链或左右分区，但每个痛点必须与页面原文对应，未给数据时不得补造百分比。',
    referenceKind: 'content',
    keywords: ['bp_pain', 'pain_point', '痛点分析', '市场痛点', '需求痛点', '问题分析', '现状分析', '需求分析'],
  },
  {
    key: 'project-overview',
    label: '项目概览页',
    informationGoal: '用最少信息回答“做什么、为谁做、如何做、产生什么价值”。',
    layout:
      '页面中央放项目一句话定义，周围按「目标对象、核心能力、交付形态、预期价值」四块展开；若内容较少，使用一张主题示意图配 3 个信息卡，不得堆叠空泛口号。',
    referenceKind: 'content',
    keywords: ['bp_intro', 'project_overview', 'overview', 'intro', '项目介绍', '项目简介', '项目概述', '项目总览', '整体概览'],
  },
  {
    key: 'solution',
    label: '解决方案页',
    informationGoal: '说明方案如何逐项回应前述问题，并展示完整作用机制。',
    layout:
      '顶部是一句方案总纲；主体采用「问题 → 核心机制/模块 → 输出价值」的映射结构，或 3-5 个相互连接的方案模块；连接关系必须可解释，避免只摆放互不相关的图标卡。',
    referenceKind: 'process',
    keywords: [
      'bp_solution', 'solution_architecture', 'solution', '解决方案', '整体方案', '核心方案', '解决思路', '方案架构',
      'bp_matching', '需求匹配', '方案匹配', '适配性分析', '契合度论证', 'requirement_match',
      'bp_feasibility', '可行性论证', '可行性分析', '方案可行性', '实现可能性', 'feasibility',
    ],
  },
  {
    key: 'product-service',
    label: '产品与服务页',
    informationGoal: '让观众看清产品形态、关键功能、使用对象和直接收益。',
    layout:
      '使用「一个主产品/服务视觉 + 3-5 个功能或服务模块」结构；每个模块包含短标题、对象/场景和一句价值说明；有真实产品截图或设备图时独立展示，文字不得压在界面或设备细节上。',
    referenceKind: 'content',
    keywords: ['bp_product', 'product_service', 'product', '产品&服务', '产品与服务', '产品介绍', '服务介绍', '产品展示', '功能介绍'],
  },
  {
    key: 'technical-route',
    label: '技术路线页',
    informationGoal: '解释输入如何经过关键技术环节形成输出，并突出技术壁垒。',
    layout:
      '采用从左到右或自下而上的 3-6 层技术路线/系统架构；每层写清输入、处理和输出，关键技术节点用统一强调色标记；不得使用无法对应正文的随机网络、芯片或代码装饰。',
    referenceKind: 'process',
    keywords: ['bp_tech', 'technology_route', 'technology', '技术路线', '技术架构', '核心技术', '技术特点', '技术方案', '技术优势', '技术创新'],
  },
  {
    key: 'innovation',
    label: '创新优势页',
    informationGoal: '明确相对基线的新做法、差异及其可验证价值。',
    layout:
      '用 3-4 个创新点组成统一证据卡，每项严格包含「相对什么不同、具体新在哪里、带来什么结果」；若文案有对比对象，使用前后/传统与本方案的成对结构，禁止只写空泛“领先、首创”。',
    referenceKind: 'content',
    keywords: [
      'bp_advantages', 'bp_innovation', 'innovation_point', 'innovation', 'project_innovation',
      'creative', 'novelty', 'breakthrough', 'advantages',
      '创新优势', '创新亮点', '核心创新', '创新点', '差异化优势', '核心优势', '创意亮点', '创新思路',
      '项目创新', '创新', '创新创意', '创意',
    ],
  },
  {
    key: 'intellectual-property',
    label: '知识产权页',
    informationGoal: '展示已提供的专利、软著、论文或技术成果如何构成保护壁垒。',
    layout:
      '采用成果类别分组或「成果 → 保护内容 → 项目作用」矩阵；只展示页面文案明确给出的名称、数量和状态，未提供证书图片时用中性文本卡，不生成伪证书、伪编号或机构 Logo。',
    referenceKind: 'content',
    keywords: ['bp_ip', 'intellectual_property', '知识产权', '专利软著', '专利成果', '软著', '成果保护', '知识产权布局'],
  },
  {
    key: 'market-analysis',
    label: '市场分析页',
    informationGoal: '说明目标市场、客户分层、需求规模或趋势，并给出清晰机会判断。',
    layout:
      '顶部先给市场结论；主体可用客户分层、趋势图或 TAM/SAM/SOM 结构，但只有页面文案给出对应数据时才能绘制规模数字；否则使用定性分层和需求证据，不得自行补造市场规模。',
    referenceKind: 'data',
    keywords: ['bp_market', 'market_analysis', 'market', '市场分析', '市场规模', '行业分析', '目标市场', '市场机会', '市场趋势'],
  },
  {
    key: 'business-model',
    label: '商业模式页',
    informationGoal: '说明价值如何创造、交付与回收，以及各参与方的关系。',
    layout:
      '使用「目标客户 → 核心价值 → 交付渠道/关键伙伴 → 收益与成本」的闭环图，或价值链加角色关系图；箭头必须体现真实流向，不得把商业画布九宫格机械塞满。',
    referenceKind: 'process',
    keywords: ['bp_business', 'business_model', '商业模式', '商业逻辑', '运营模式', '盈利逻辑', '价值闭环'],
  },
  {
    key: 'revenue-model',
    label: '盈利模式页',
    informationGoal: '解释谁付费、为什么付费、按什么方式收费以及收入如何增长。',
    layout:
      '按付费对象或收入来源拆成 2-4 条清晰路径，每条包含「客户/场景、收费项、计费方式、价值依据」；若没有具体价格，不生成金额，只保留模式说明。',
    referenceKind: 'process',
    keywords: ['bp_revenue', 'revenue_model', '盈利模式', '收入模式', '营收模式', '商业变现', '盈利方式'],
  },
  {
    key: 'competitive-analysis',
    label: '竞争分析页',
    informationGoal: '用统一维度比较方案与替代选择，并得出可辩护的竞争结论。',
    layout:
      '采用 3-6 个统一维度的对比矩阵、象限或 SWOT 结构，维度名称置于左侧，比较对象置于顶部；结论区单独说明本方案优势与仍需补强项，禁止用没有依据的全优勾选。',
    referenceKind: 'data',
    keywords: ['bp_competition', 'competitive_analysis', '竞争分析', '竞品分析', 'SWOT分析', 'swot', '对标分析', '竞争格局', '竞争优势'],
  },
  {
    key: 'big-number',
    label: '大数字指标页',
    informationGoal: '突出最能证明进展或价值的少量核心指标。',
    layout:
      '3-4 个 KPI 指标卡片横向等宽排成一行（或 2×2 网格），每张卡片中央是超大号数字（含单位），数字下方一行指标名称、可选一行口径/时间注释；卡片样式统一、边界分明、间距一致。',
    referenceKind: 'data',
    keywords: ['bp_metrics', 'traction_metrics', 'traction', 'metrics', '大数字指标', '数据总览', '核心数据', '成果数字', '经营数据', '运营数据', 'KPI', '指标', '核心指标', '业绩数据'],
  },
  {
    key: 'data-chart',
    label: '数据图表页',
    informationGoal: '用正确图表回答一个趋势、对比、构成或关联问题。',
    layout:
      '1 个主图表（必要时加 1 个辅助图表）占据中部主要区域；图表类型必须匹配数据关系，坐标轴、单位、图例与时间范围清楚；图表旁边或下方放 1-2 句结论，其中关键数字可大号强调。',
    referenceKind: 'data',
    keywords: ['data_chart', '数据图表', '图表分析', '数据分析', '统计分析', '趋势图', '占比图', '图表', '统计', '趋势', '占比'],
  },
  {
    key: 'case-study',
    label: '案例与成果页',
    informationGoal: '用真实案例说明方案在什么场景、如何落地并产生什么结果。',
    layout:
      '案例名称作为小标题置于上方；主体为「场景/对象 + 做法 + 结果证据」的组合，可采用一张案例图配 2-3 条说明；若有成果数据，用大号数字单独强调，并保留时间或口径。',
    referenceKind: 'content',
    keywords: ['bp_cases', 'case_study', '示范案例', '典型案例', '客户案例', '落地案例', '实施成果', '案例展示', '项目实例', '实践案例'],
  },
  {
    key: 'endorsement',
    label: '成果与权威背书页',
    informationGoal: '呈现已提供的合作、资质、评价、荣誉或第三方证据，并说明其证明意义。',
    layout:
      '按证据类型组织 2-5 张卡片，每张包含「证据名称/来源、时间或状态、证明了什么」；只有用户提供真实标识或证书图时才展示原图，否则使用中性文本卡，禁止臆造奖项、媒体、机构 Logo 或签章。',
    referenceKind: 'content',
    keywords: [
      'bp_endorsement', 'bp_recognition', 'social_proof', '权威背书', '机构背书', '合作背书', '社会认可',
      '荣誉证明', '媒体报道', '资质背书', '外部认可', '佐证材料',
      '专家评价', '专家评审', '专家意见', '专家推荐', 'expert_review',
    ],
  },
  {
    key: 'social-impact',
    label: '社会价值页',
    informationGoal: '说明项目为哪些群体带来何种可持续改变，并区分产出与结果。',
    layout:
      '按 3-4 类受益对象或价值维度组织「行动 → 直接产出 → 长期影响」；有量化数据时就近标注，未提供时使用定性结果，不生成宏大但无法验证的公益数字。',
    referenceKind: 'content',
    keywords: [
      'bp_impact', 'social_impact', '社会价值', '社会效益', '社会影响', '公益价值', '公益贡献',
      'bp_benefits', '效益评估', '效益分析', '价值评估', '经济效益', 'impact_assessment',
    ],
  },
  {
    key: 'education-impact',
    label: '教育实效页',
    informationGoal: '展示课程、实践、赛事或产教融合如何带来学习与人才培养结果。',
    layout:
      '采用「培养目标 → 教学/实践机制 → 学习成果/成长证据」三段结构；可配课程、实训或师生协作的真实场景，避免用学生剪影和奖杯替代教育证据。',
    referenceKind: 'content',
    keywords: [
      'bp_education', 'bp_growth', 'educational_impact', '教育实效', '教育价值', '实践育人', '思政成长',
      '个人成长', '参赛收获', '课程融合', '产教融合', '成长收获', 'personal_growth',
      '校企合作', '工学结合', '产教结合', 'school_enterprise',
    ],
  },
  {
    key: 'implementation-plan',
    label: '实施方案页',
    informationGoal: '明确工作包、责任、时间、依赖和验收结果，使方案可执行。',
    layout:
      '采用 3-5 个阶段或工作包，每个阶段包含「任务、责任对象/协同方、交付物、时间或验收标准」；可用泳道、里程碑或分阶段卡片，禁止只列空泛动词。',
    referenceKind: 'process',
    keywords: [
      'bp_implementation', 'bp_operations', 'execution_plan', '实施方案', '执行规划', '执行计划',
      '运营计划', '落地计划', '行动计划', '推进机制',
      'bp_sustainability', '可持续性', '可持续发展', '自我造血', '运营保障', '持续运营', 'sustainability',
      'bp_replication', '推广复制', '推广计划', '规模化', '模式复制', '推广路径', 'scale_up',
    ],
  },
  {
    key: 'skills-showcase',
    label: '作品与技能展示页',
    informationGoal: '让观众看懂作品、技能动作或工艺过程的关键步骤与质量标准。',
    layout:
      '主体使用 3-5 个连续画面/步骤框，每格包含动作或作品局部、步骤名与关键标准；优先真实作品、设备或操作照片，没有素材时用准确扁平示意图，不生成虚构获奖现场。',
    referenceKind: 'process',
    keywords: [
      'bp_craft', 'bp_skill_demo', 'skill_showcase', '作品展示', '技能演示', '技能展示', '工艺展示', '技艺展示', '操作演示',
      '原型展示', '制作成果', '模型展示', 'demo', 'prototype', '工匠作品', 'craftsmanship',
    ],
  },
  {
    key: 'funding-plan',
    label: '融资与资金规划页',
    informationGoal: '说明资金需求、用途、阶段目标和预期里程碑。',
    layout:
      '左侧或顶部呈现资金总需求（仅在文案提供时），主体将资金用途拆成 3-5 项并对应阶段里程碑；股权、估值和回报信息只有原文明确给出时才展示，不得自行计算或编造。',
    referenceKind: 'data',
    keywords: [
      'bp_funding', 'bp_equity', 'funding_plan', 'funding', '融资规划', '资金规划', '投资计划', '融资方案', '资金需求',
      '股权结构', '股权分配', '持股比例', '股东结构', 'equity', 'equity_structure',
    ],
  },
  {
    key: 'timeline',
    label: '时间轴页',
    informationGoal: '按时间顺序展示关键事件、里程碑和阶段成果。',
    layout:
      '一条横向（或纵向）时间轴贯穿页面，轴上 4-6 个节点等距分布；每个节点包含时间标签与一句事件短句，节点交替或同侧排布，连线与节点样式全套统一。',
    referenceKind: 'process',
    keywords: [
      'strategy_roadmap', 'roadmap', '发展路线图', '规划路线', '发展阶段', '时间轴', '时间线', '历程', '里程碑',
      '战略目标', '发展规划', '路线图', '发展计划', '战略规划', '项目历程',
      'bp_future', '未来计划', '后续计划', '改进方向', '发展方向', 'next_steps', 'future',
    ],
  },
  {
    key: 'comparison',
    label: '双栏对比页',
    informationGoal: '用同一组维度清楚展示两种状态、方案或对象的差异。',
    layout:
      '左右两栏严格对称，每栏一个小标题加 3-4 条同维度要点；两栏之间用细分隔线或居中对照标识区隔；结论置于底部独立横条，不得只靠颜色暗示优劣。',
    referenceKind: 'data',
    keywords: ['before_after', '竞品对比', '方案对比', '前后变化', '传统与', '优劣对比', '双栏对比', '比较页', '对比页'],
  },
  {
    key: 'process',
    label: '流程步骤页',
    informationGoal: '说明一个过程如何按顺序发生，以及各步骤间的输入输出关系。',
    layout:
      '3-5 个步骤按顺序横向（或纵向）排列，步骤之间用箭头或连线串联；每步统一样式：步骤编号 + 步骤名称 + 一句简短说明；起点终点明确，整体居中对齐。',
    referenceKind: 'process',
    keywords: ['bp_process', 'process', '实施步骤', '操作步骤', '流程步骤', '推进安排', '三阶段', '流程', '步骤', '路径', '实践过程', '探究过程', '研究过程'],
  },
  {
    key: 'quote',
    label: '金句引用页',
    informationGoal: '突出一条原文中的核心观点、愿景或权威原话。',
    layout:
      '一句金句或引言以大字居中排布为唯一主体，可配简洁引号或细线装饰；下方一行小字注明页面文案中真实给出的出处或说话人；其余区域大量留白，不使用艺术变形字体。',
    referenceKind: 'section',
    keywords: ['quotation', '金句', '引用', '引言', '语录', '核心观点', '理念'],
  },
  {
    key: 'image-text',
    label: '图文并列页',
    informationGoal: '用一张直接相关的图像帮助解释一个场景、对象或案例。',
    layout:
      '页面左右分为两个清晰区域：一侧是一张与正文实体直接相关的主题配图（图片上不得压文字），另一侧是小标题加 2-4 条要点；两区比例约 1:1 或 2:3，垂直居中对齐。',
    referenceKind: 'content',
    keywords: ['image_text', '图文并列', '图文页', '配图页', '场景展示', '实拍页'],
  },
  {
    key: 'table',
    label: '表格页',
    informationGoal: '以行列结构准确呈现参数、清单、责任或多维对照信息。',
    layout:
      '一个规整表格为页面主体：表头使用主色底或浅色强调，数据行轻微交替；全表建议不超过 5 列 6 行，单元格文字简短；表格居中，列宽按内容对齐，重点单元格只用一种强调色。',
    referenceKind: 'data',
    keywords: ['data_table', '参数表格', '数据表格', '对照表', '责任表', '清单表', '表格', '明细', '参数'],
  },
  {
    key: 'team',
    label: '团队介绍页',
    informationGoal: '说明团队角色、能力与项目任务之间的匹配关系。',
    layout:
      '2-4 张成员卡片等宽横排或网格排列；每张卡片为「真实头像（仅在提供时）/中性头像位 + 姓名 + 职位 + 与项目相关的一句话能力」；不得生成虚构姓名、履历、专家或人脸。',
    referenceKind: 'content',
    keywords: [
      'bp_team', 'bp_advisors', 'team_members', 'team', 'members', 'advisors', 'mentors',
      '团队介绍', '团队成员', '核心团队', '指导团队', '指导老师', '专家顾问', '成员介绍', '组织架构',
      '团队', '团队协作', '导师团队',
    ],
  },
  {
    key: 'bullets',
    label: '要点罗列页',
    informationGoal: '把同层级的举措、优势或建议压缩成可快速扫读的要点组。',
    layout:
      '3-5 个要点以统一卡片或列表项呈现：每项为「简洁图标 + 要点短标题 + 一行说明」；各项等高等距、纵向列表或网格排列，图标风格全套统一。',
    referenceKind: 'content',
    keywords: ['key_points', '要点罗列', '核心举措', '关键举措', '主要优势', '行动建议', '亮点', '策略', '建议', '功能', '要点'],
  },
  {
    key: 'design',
    label: '项目设计页',
    informationGoal: '把项目要解决的问题与对应的设计目标连接成一条可检验的依据链。',
    layout:
      '上半部用 2-3 条证据界定问题（命题要求、对象现状或痛点），下半部给出与之一一对应的设计目标与总体思路；问题与设计目标之间用箭头或编号建立明确映射，不得让两边各自孤立成块。',
    referenceKind: 'content',
    keywords: ['design', 'project_design', 'context', 'situation', 'problem', 'challenge', '项目设计', 'bp_problem', '命题解析', '企业命题', '需求解读', '命题背景', 'proposition'],
  },
  {
    key: 'workflow',
    label: '工作流程页',
    informationGoal: '让观众一眼看懂从输入到成果的总体工作流程与各环节职责。',
    layout:
      '一条主流程线从左到右（或自上而下）贯穿页面，4-6 个环节等距排布；每个环节为「环节名 + 一句输入/产出说明」，环节之间用箭头标明真实流向；起点与终点清晰，禁止只摆名词不成流。',
    referenceKind: 'process',
    keywords: ['workflow', 'introduction', 'project_intro', 'overall_solution', 'overall_idea', 'approach', 'architecture', '工作流程', '总体思路', '总体设计'],
  },
  {
    key: 'skill',
    label: '技能要点页',
    informationGoal: '说明完成项目所依赖的关键技能、应用环节与掌握标准。',
    layout:
      '3-5 个技能点以统一卡片呈现，每卡包含「技能名称 + 用在哪个环节 + 一句掌握标准或关键要领」；卡片等宽等距排列，可用统一编号或图标区分层级，不堆砌与项目无关的技能名词。',
    referenceKind: 'content',
    keywords: ['skill', 'skills', 'skills_demo', 'skill_demo', '技能要点', '核心技能'],
  },
  {
    key: 'outcomes',
    label: '项目成果页',
    informationGoal: '集中展示项目已经产出的作品、数据与成果证据。',
    layout:
      '成果按类别组织成 2-4 组，可量化的成果用超大号数字单独强调并标注口径；实物或作品类成果配图片位，每条成果写明「名称 + 证据」；只呈现页面文案明确给出的成果，不得虚构数量与奖项。',
    referenceKind: 'data',
    keywords: ['outcomes', 'project_outcomes', 'project_result', 'achievement', 'outcome', 'result', '项目成果', '主要成果', '成果'],
  },
  {
    key: 'value',
    label: '应用价值页',
    informationGoal: '说明成果在真实场景中为谁使用、如何解决并带来什么改变。',
    layout:
      '按「应用场景/受益对象 → 应用方式 → 实际价值」组织 2-4 条价值链；每条尽量落到可验证的结果，文案未给数据时使用定性描述；可用场景配图位，但不得用泛化素材替代真实应用对象。',
    referenceKind: 'content',
    keywords: ['value', 'application_value', 'application', 'benefit', 'impact', '应用价值', '价值', '应用'],
  },
  {
    key: 'content',
    label: '通用内容页',
    informationGoal: '围绕一个明确结论组织 2-3 组相互关联的事实或论据。',
    layout:
      '页面标题置于顶部标题区，并尽量写成观点句；正文由 2-3 个边界分明的内容块组成，块间距一致、左右对齐到同一栅格；每块一个小标题加简短正文，底部可放一句结论或来源说明。',
    referenceKind: 'content',
    keywords: [],
  },
]

const GENERIC = PAGE_TYPES[PAGE_TYPES.length - 1]
const BY_KEY = new Map(PAGE_TYPES.map((spec) => [spec.key, spec]))

function normalize(value: string): string {
  return cleanString(value, 240).toLowerCase().replace(/[\s_\-/]+/g, '')
}

/**
 * 归一页型：角色为 cover/toc/section/ending 时角色优先；其余先做精确别名匹配，
 * 再做最长关键词包含匹配，无命中时兜底通用内容页。
 */
export function resolvePageType(pageType: string, role: string): PageTypeSpec {
  const cleanRole = cleanString(role, 40).toLowerCase()
  const roleHit = ROLE_KEYS.has(cleanRole) ? BY_KEY.get(cleanRole) : undefined
  if (roleHit) return roleHit

  const text = normalize(pageType)
  if (!text) return GENERIC

  for (const spec of PAGE_TYPES) {
    if (spec.keywords.some((keyword) => normalize(keyword) === text)) return spec
  }

  let best: PageTypeSpec | null = null
  let bestScore = 0
  for (const spec of PAGE_TYPES) {
    for (const keyword of spec.keywords) {
      const normalizedKeyword = normalize(keyword)
      if (normalizedKeyword.length > bestScore && text.includes(normalizedKeyword)) {
        best = spec
        bestScore = normalizedKeyword.length
      }
    }
  }
  return best ?? GENERIC
}
