export interface SiteAnnouncement {
  enabled: boolean
  html: string
  backgroundColor: string
  textColor: string
  revision: number
}

export interface SiteConfig {
  siteName: string
  /** 对外公开站点地址，用于 canonical / sitemap / 分享卡片 */
  publicBaseUrl: string
  /** 页脚展示的运营主体名称 */
  companyName: string
  /** 中国 ICP 备案号；未配置时不渲染 */
  icpNumber: string
  /** 隐私政策 / 服务条款最后更新时间 */
  legalUpdatedAt: string
  /** 注册赠送星星数 */
  signupBonusPoints: number
  beginnerTutorialUrl: string
  serviceEmail: string
  announcement: SiteAnnouncement
}

const DEFAULT_ANNOUNCEMENT_HTML =
  '🎉 AnPPT 新版上线，注册即送 100 🌟 星星'

/**
 * 站点配置：常量默认值 + 环境变量覆盖（ANPPT_*）。
 * 同时通过 GET /api/public/site-config 对外只读暴露。
 */
export function getSiteConfig(): SiteConfig {
  const env = process.env
  return {
    siteName: 'AnPPT',
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'https://ppt.an520.xin').replace(/\/+$/, ''),
    companyName: env.ANPPT_COMPANY_NAME ?? 'AnPPT',
    icpNumber: env.ANPPT_ICP_NUMBER ?? '',
    legalUpdatedAt: '2026-10-19',
    signupBonusPoints: Number(env.ANPPT_SIGNUP_BONUS_POINTS ?? 100),
    beginnerTutorialUrl: env.ANPPT_TUTORIAL_URL ?? '',
    serviceEmail: env.ANPPT_SERVICE_EMAIL ?? 'support@anppt.app',
    announcement: {
      enabled: (env.ANPPT_ANNOUNCEMENT_ENABLED ?? 'true') !== 'false',
      html: env.ANPPT_ANNOUNCEMENT_HTML ?? DEFAULT_ANNOUNCEMENT_HTML,
      backgroundColor: env.ANPPT_ANNOUNCEMENT_BG ?? '#F2571A',
      textColor: env.ANPPT_ANNOUNCEMENT_COLOR ?? '#ffffff',
      revision: Number(env.ANPPT_ANNOUNCEMENT_REVISION ?? 1),
    },
  }
}
