export interface RechargePlan {
  id: string
  name: string
  subtitle: string
  /** 人民币价格（元） */
  price: number
  /** 划线原价（元） */
  originalPrice: number
  /** 星星数量 */
  points: number
  bonusText: string | null
  /** 按 10🌟/页 换算的页数 */
  estimatedPages: number
  recommended: boolean
  suitableFor: string
}

export const RECHARGE_PLANS: RechargePlan[] = [
  {
    id: 'pack-100',
    name: '新人尝鲜包',
    subtitle: '首次体验刚刚好',
    price: 9.9,
    originalPrice: 12.9,
    points: 100,
    bonusText: '尝鲜价',
    estimatedPages: 10,
    recommended: false,
    suitableFor: '首次体验用户',
  },
  {
    id: 'pack-500',
    name: '轻量创作包',
    subtitle: '日常汇报主力档',
    price: 39.9,
    originalPrice: 49.9,
    points: 500,
    bonusText: null,
    estimatedPages: 50,
    recommended: true,
    suitableFor: '每月 1–2 次，适合日报、复盘、述职和中型方案',
  },
  {
    id: 'pack-1000',
    name: '职场常用包',
    subtitle: '高频创作更划算',
    price: 79.9,
    originalPrice: 89.9,
    points: 1000,
    bonusText: null,
    estimatedPages: 100,
    recommended: false,
    suitableFor: '每月 3–5 次，适合月报、项目汇报、方案及管理层使用',
  },
  {
    id: 'pack-2000',
    name: '高频项目包',
    subtitle: '量大管饱最划算',
    price: 149.9,
    originalPrice: 179.9,
    points: 2000,
    bonusText: null,
    estimatedPages: 200,
    recommended: false,
    suitableFor: '每月制作大于 5 次，适合咨询、培训、投标、设计等行业人群',
  },
]

export interface PricingRule {
  group: string
  action: string
  description: string
  cost: string
  badge: string | null
}

/** 「扣费明细 · 星星花在哪里」规则表 */
export const PRICING_RULES: PricingRule[] = [
  {
    group: '注册与赠送',
    action: '新用户注册赠送',
    description: '注册即送星星，可直接用于生成',
    cost: '+100 🌟',
    badge: '注册即得',
  },
  {
    group: 'AI 内容生成',
    action: '大纲生成',
    description: '上传文档或录入内容后，AI 梳理整套 PPT 大纲',
    cost: '免费',
    badge: '限时免费',
  },
  {
    group: 'AI 内容生成',
    action: '页面生成（标准模式）',
    description: '每页生成一张精设计配图，失败自动退回',
    cost: '10 🌟/页',
    badge: null,
  },
  {
    group: 'PPT 导出',
    action: '图片版导出',
    description: '整套生成图直接嵌入 PPTX，免费导出',
    cost: '免费',
    badge: '限时免费',
  },
  {
    group: 'PPT 导出',
    action: '可编辑导出',
    description: 'OCR 识别重建文本框，导出可编辑 PPTX',
    cost: '20 🌟/页',
    badge: '即将上线',
  },
  {
    group: '保障',
    action: '生成失败自动退回',
    description: '生成失败或主动取消，未使用星星自动退回余额',
    cost: '自动退回',
    badge: null,
  },
]

export interface BenefitColumn {
  icon: string
  title: string
  items: { text: string; badge: string | null }[]
}

/** 「上线权益 · 任一套餐均包含」三栏 */
export const RECHARGE_BENEFITS: BenefitColumn[] = [
  {
    icon: '📄',
    title: 'AI 内容与大纲',
    items: [
      { text: 'AI 内容解析：上传文档或文字，AI 先帮你提取和分析内容', badge: '限时免费' },
      { text: 'AI 智能大纲梳理：先规划页面、逻辑和章节，不是直接把文字塞进模板', badge: '限时免费' },
      { text: '大纲调整：生成前可继续调整结构、顺序和详略', badge: '限时免费' },
    ],
  },
  {
    icon: '🎨',
    title: 'PPT 设计与生成',
    items: [
      { text: 'AI 页面内容梳理：把大纲文字提炼成适合 PPT 表达的页面内容', badge: null },
      { text: '风格包选择和使用：使用设计师团队预设的精品 PPT 风格', badge: null },
      { text: '逐页生成：确认风格后直接整套生成，逐页可见、失败免费重试', badge: null },
      { text: '对话改图：对不满意的页面用自然语言直接改', badge: null },
    ],
  },
  {
    icon: '⬇️',
    title: '导出与项目管理',
    items: [
      { text: '图片版导出：图片版 PPTX 免费导出，可以直接演示和汇报', badge: '限时免费' },
      { text: '可编辑导出：真正需要修改文字时，按页导出可编辑版本', badge: '即将上线' },
      { text: '实时云端保存：项目云端实时保存，7 天内可随时下载', badge: null },
    ],
  },
]
