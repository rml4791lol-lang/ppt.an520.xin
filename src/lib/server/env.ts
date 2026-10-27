import path from 'node:path';

export interface RechargePlan {
  id: string;
  label: string;
  amountFen: number;
  credits: number;
  featured?: boolean;
  description?: string;
}

export interface WechatPayConfig {
  enabled: boolean;
  mock: boolean;
  appId: string;
  mchId: string;
  apiV3Key: string;
  serialNo: string;
  privateKeyPem: string;
  privateKeyPath: string;
  platformPublicKeyPem: string;
  platformPublicKeyPath: string;
  notifyUrl: string;
}

export interface EpayConfig {
  enabled: boolean;
  mock: boolean;
  gateway: string;
  pid: string;
  key: string;
  notifyUrl: string;
  returnUrl: string;
  defaultType: string;
  device: string;
  useMapi: boolean;
  allowedTypes: string[];
}

export interface ServerEnv {
  isProduction: boolean;
  dbPath: string;
  sessionCookieName: string;
  sessionTtlMs: number;
  cookieSecure: 'auto' | 'always' | 'never';
  otpHmacSecret: string;
  otpDevEcho: boolean;
  signupBonusCredits: number;
  smtp: { host: string; port: number; user: string; pass: string; from: string };
  smtpReady: boolean;
  aliyunSms: { accessKeyId: string; accessKeySecret: string; signName: string; templateCode: string };
  smsReady: boolean;
  publicBaseUrl: string;
  wechat: WechatPayConfig;
  epay: EpayConfig;
  rechargePlans: RechargePlan[];
  rechargeOrderTtlMs: number;
}

const DEFAULT_RECHARGE_PLANS: RechargePlan[] = [
  { id: 'pack-100', label: '新人尝鲜包', amountFen: 990, credits: 100, description: '首次体验刚刚好' },
  { id: 'pack-500', label: '轻量创作包', amountFen: 3990, credits: 500, featured: true, description: '日常汇报主力档' },
  { id: 'pack-1000', label: '职场常用包', amountFen: 7990, credits: 1000, description: '高频创作更划算' },
  { id: 'pack-2000', label: '高频项目包', amountFen: 14990, credits: 2000, description: '量大管饱最划算' },
];

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function intFromEnv(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function joinUrl(base: string, p: string): string {
  if (!base) return '';
  return `${base}${p.startsWith('/') ? p : `/${p}`}`;
}

function parsePlansJson(raw: string): RechargePlan[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const plans: RechargePlan[] = [];
    for (const item of parsed) {
      const id = trim(item?.id);
      const amountFen = Number(item?.amountFen ?? Math.round(Number(item?.priceYuan) * 100));
      const credits = Number(item?.credits);
      if (!id || !Number.isSafeInteger(amountFen) || amountFen <= 0 || !Number.isSafeInteger(credits) || credits <= 0) {
        return null;
      }
      plans.push({
        id,
        label: trim(item?.label) || id,
        amountFen,
        credits,
        featured: Boolean(item?.featured),
        description: trim(item?.description) || undefined,
      });
    }
    return plans.length > 0 ? plans : null;
  } catch {
    return null;
  }
}

function loadWechatConfig(publicBaseUrl: string, isProduction: boolean): WechatPayConfig {
  const e = process.env;
  const mock = trim(e.WECHAT_PAY_MOCK) === 'true';
  // 生产硬拒 mock：免验签回调只许存在于非生产；误开时降级为强制走真实验签（失败闭）并大字告警
  if (mock && isProduction) {
    console.error('[anppt-v2][payments] 生产环境检测到 WECHAT_PAY_MOCK=true，已强制关闭 mock（回调将全部走验签）');
  }
  return {
    enabled: trim(e.WECHAT_PAY_ENABLED) === 'true',
    mock: mock && !isProduction,
    appId: trim(e.WECHAT_PAY_APP_ID || e.WECHAT_APP_ID),
    mchId: trim(e.WECHAT_PAY_MCH_ID),
    apiV3Key: trim(e.WECHAT_PAY_API_V3_KEY),
    serialNo: trim(e.WECHAT_PAY_SERIAL_NO || e.WECHAT_PAY_MERCHANT_SERIAL),
    privateKeyPem: trim(e.WECHAT_PAY_PRIVATE_KEY),
    privateKeyPath: trim(e.WECHAT_PAY_PRIVATE_KEY_PATH),
    platformPublicKeyPem: trim(e.WECHAT_PAY_PLATFORM_PUBLIC_KEY),
    platformPublicKeyPath: trim(e.WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE || e.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH),
    notifyUrl: trim(e.WECHAT_PAY_NOTIFY_URL) || joinUrl(publicBaseUrl, '/api/recharge/notify/wechat'),
  };
}

function loadEpayConfig(publicBaseUrl: string, isProduction: boolean): EpayConfig {
  const e = process.env;
  const allowedTypes = trim(e.EPAY_PAY_TYPES || 'alipay')
    .split(/[,;]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const mock = trim(e.EPAY_MOCK) === 'true';
  if (mock && isProduction) {
    console.error('[anppt-v2][payments] 生产环境检测到 EPAY_MOCK=true，已强制关闭 mock（回调将全部走验签）');
  }
  return {
    enabled: trim(e.EPAY_ENABLED) === 'true',
    mock: mock && !isProduction,
    gateway: trim(e.EPAY_GATEWAY || e.EPAY_API_URL).replace(/\/+$/, ''),
    pid: trim(e.EPAY_PID || e.EPAY_MERCHANT_ID),
    key: trim(e.EPAY_KEY || e.EPAY_MERCHANT_KEY),
    notifyUrl: trim(e.EPAY_NOTIFY_URL) || joinUrl(publicBaseUrl, '/api/recharge/notify/epay'),
    returnUrl: trim(e.EPAY_RETURN_URL) || joinUrl(publicBaseUrl, '/?billing=success'),
    defaultType: trim(e.EPAY_DEFAULT_TYPE || 'alipay').toLowerCase(),
    device: trim(e.EPAY_DEVICE || 'jump').toLowerCase(),
    useMapi: trim(e.EPAY_USE_MAPI) !== 'false',
    allowedTypes: allowedTypes.length > 0 ? allowedTypes : ['alipay'],
  };
}

function loadEnv(): ServerEnv {
  const e = process.env;
  const isProduction = e.NODE_ENV === 'production';
  const dbPath = trim(e.ANPPT_V2_DB_PATH) || path.resolve(process.cwd(), 'data', 'anppt-v2.db');
  const configuredOtpSecret = trim(e.ANPPT_OTP_HMAC_SECRET);
  const publicBaseUrl = trim(e.PUBLIC_BASE_URL || e.ANPPT_PUBLIC_BASE_URL).replace(/\/+$/, '');
  const cookieSecureRaw = trim(e.ANPPT_COOKIE_SECURE).toLowerCase();
  const smtp = {
    host: trim(e.SMTP_HOST),
    port: intFromEnv(e.SMTP_PORT, 465),
    user: trim(e.SMTP_USER),
    pass: trim(e.SMTP_PASS),
    from: trim(e.SMTP_FROM) || trim(e.SMTP_USER),
  };
  const aliyunSms = {
    accessKeyId: trim(e.ALIYUN_SMS_ACCESS_KEY_ID),
    accessKeySecret: trim(e.ALIYUN_SMS_ACCESS_KEY_SECRET),
    signName: trim(e.ALIYUN_SMS_SIGN_NAME),
    templateCode: trim(e.ALIYUN_SMS_TEMPLATE_CODE),
  };
  return {
    isProduction,
    dbPath,
    sessionCookieName: 'anppt_v2_session',
    sessionTtlMs: intFromEnv(e.ANPPT_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    cookieSecure: cookieSecureRaw === 'true' ? 'always' : cookieSecureRaw === 'false' ? 'never' : 'auto',
    otpHmacSecret: configuredOtpSecret,
    otpDevEcho: !isProduction && trim(e.OTP_DEV_ECHO) === 'true',
    signupBonusCredits: intFromEnv(e.SIGNUP_BONUS_CREDITS, 100),
    smtp,
    smtpReady: Boolean(smtp.host && smtp.port && smtp.user && smtp.pass),
    aliyunSms,
    smsReady: Boolean(
      aliyunSms.accessKeyId && aliyunSms.accessKeySecret && aliyunSms.signName && aliyunSms.templateCode,
    ),
    publicBaseUrl,
    wechat: loadWechatConfig(publicBaseUrl, isProduction),
    epay: loadEpayConfig(publicBaseUrl, isProduction),
    rechargePlans: parsePlansJson(trim(e.RECHARGE_PLANS)) || DEFAULT_RECHARGE_PLANS,
    rechargeOrderTtlMs: intFromEnv(e.RECHARGE_ORDER_TTL_MS, 2 * 60 * 60 * 1000),
  };
}

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (!cached) {
    cached = loadEnv();
    logStartupWarnings(cached);
  }
  return cached;
}

let warningsLogged = false;

function logStartupWarnings(env: ServerEnv): void {
  if (warningsLogged || !env.isProduction) return;
  warningsLogged = true;
  for (const warning of collectStartupWarnings(env)) {
    console.warn(`[anppt-v2][config] ${warning}`);
  }
}

export function collectStartupWarnings(env: ServerEnv): string[] {
  const warnings: string[] = [];
  if (!env.isProduction) return warnings;
  if (!env.otpHmacSecret) warnings.push('ANPPT_OTP_HMAC_SECRET 未配置，OTP 验证码登录将不可用');
  if (!env.smtpReady) warnings.push('SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS 未配齐，邮件验证码将不可用');
  if (env.otpDevEcho) warnings.push('OTP_DEV_ECHO 在生产环境被忽略');
  if (!env.publicBaseUrl) warnings.push('PUBLIC_BASE_URL 未配置，支付回调地址缺失');
  const wechatReady = env.wechat.enabled && (env.wechat.mock || Boolean(env.wechat.mchId && env.wechat.appId && env.wechat.apiV3Key));
  const epayReady = env.epay.enabled && (env.epay.mock || Boolean(env.epay.gateway && env.epay.pid && env.epay.key));
  if (!wechatReady && !epayReady) warnings.push('微信支付与 epay 均未完整配置，充值将不可用');
  return warnings;
}
