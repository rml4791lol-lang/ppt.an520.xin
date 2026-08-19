export interface SiteAnnouncement {
  enabled: boolean
  html: string
  backgroundColor: string
  textColor: string
  revision: number
}

export interface SiteConfig {
  siteName: string
  /** 注册赠送星星数 */
  signupBonusPoints: number
  /** 每页生成消耗（标准模式） */
  pointsPerPage: number
  beginnerTutorialUrl: string
  serviceEmail: string
  announcement: SiteAnnouncement
}

const DEFAULT_ANNOUNCEMENT_HTML =
  '🎉 AnPPT 新版上线，注册即送 100 🌟 星星，生成 10 🌟/页'

/**
 * 站点配置：常量默认值 + 环境变量覆盖（ANPPT_*）。
 * 同时通过 GET /api/public/site-config 对外只读暴露。
 */
export function getSiteConfig(): SiteConfig {
  const env = process.env
  return {
    siteName: 'AnPPT',
    signupBonusPoints: Number(env.ANPPT_SIGNUP_BONUS_POINTS ?? 100),
    pointsPerPage: Number(env.ANPPT_POINTS_PER_PAGE ?? 10),
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
