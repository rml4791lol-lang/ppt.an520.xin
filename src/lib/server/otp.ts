import { createHmac, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import { getDb, withTransaction } from './db';
import { getEnv } from './env';
import { ApiError, validationError } from './http';
import {
  classifyIdentifier,
  createSessionForUser,
  createUserTx,
  findUserByEmail,
  findUserByPhone,
  sha256,
  type AuthResult,
  type PublicUser,
} from './auth';
import { sendSmsCode } from './sms';
import { grantSignupBonusTx } from './credits';
import { logProblem } from './problem-log';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_IDENTIFIER_HOURLY_MAX = 6;
const OTP_CLIENT_HOURLY_MAX = 30;

function safeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(String(value)).digest('hex');
}

// Dev fallback keeps local setups working without a configured secret;
// production without ANPPT_OTP_HMAC_SECRET disables OTP entirely.
function effectiveOtpSecret(): string {
  const env = getEnv();
  if (env.otpHmacSecret) return env.otpHmacSecret;
  if (env.isProduction) return '';
  return sha256(`anppt-v2-dev-otp:${env.dbPath}`);
}

export function otpAvailability(): { enabled: boolean; email: boolean; phone: boolean; devEcho: boolean } {
  const env = getEnv();
  const hasSecret = effectiveOtpSecret().length > 0;
  return {
    enabled: hasSecret && (env.smtpReady || env.smsReady || env.otpDevEcho),
    email: hasSecret && (env.smtpReady || env.otpDevEcho),
    phone: hasSecret && (env.smsReady || env.otpDevEcho),
    devEcho: env.otpDevEcho,
  };
}

function identifierHash(secret: string, email: string): string {
  return hmacHex(secret, `identity:${email}`);
}

function clientHash(secret: string, clientIp: string): string {
  return hmacHex(secret, `client:${clientIp || 'unknown'}`);
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  const stars = '*'.repeat(Math.min(6, Math.max(2, local.length - visible.length)));
  return `${visible}${stars}@${domain}`;
}

function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '***';
}

function emailHtml(code: string): string {
  return `
    <div style="max-width:480px;margin:0 auto;padding:32px 24px;background:#090a09;color:#f0ede6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="margin-bottom:20px;color:#d3b573;font-size:18px;font-weight:700">AnPPT</div>
      <div style="border:1px solid #39342a;border-left:2px solid #d3b573;background:#111211;padding:24px">
        <p style="margin:0;color:#9d9a91;font-size:14px">你正在登录 AnPPT，验证码为：</p>
        <p style="margin:24px 0;text-align:center;color:#ead495;font-family:ui-monospace,monospace;font-size:32px;font-weight:800;letter-spacing:6px">${code}</p>
        <p style="margin:0;text-align:center;color:#77746d;font-size:12px">验证码 10 分钟内有效，请勿转发给他人</p>
      </div>
      <p style="margin-top:16px;text-align:center;color:#66635d;font-size:11px">如非本人操作，请忽略此邮件</p>
    </div>
  `;
}

let transporterPromise: Promise<nodemailer.Transporter> | null = null;

function getTransporter(): Promise<nodemailer.Transporter> {
  if (!transporterPromise) {
    const { smtp } = getEnv();
    transporterPromise = Promise.resolve(
      nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465,
        auth: { user: smtp.user, pass: smtp.pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      }),
    );
  }
  return transporterPromise;
}

/**
 * 解析 SMTP_FROM：支持 `显示名 <地址>` 写法，裸地址则用固定显示名。
 * 地址取 SMTP_FROM 覆盖值（env 已默认回退 SMTP_USER）——中继/代发场景发信地址可以不等于登录账号；
 * QQ 邮箱要求 From 地址 = SMTP_USER 的约束交给部署侧（设 SMTP_FROM=$SMTP_USER 或不设）。
 */
export function parseSmtpFrom(value: string): { name: string; address: string } {
  const raw = String(value || '').trim();
  const matched = /^(.*)<([^<>]+)>\s*$/.exec(raw);
  if (!matched) return { name: 'AnPPT', address: raw };
  const name = matched[1].trim().replace(/^"(.*)"$/, '$1').trim();
  return { name: name || 'AnPPT', address: matched[2].trim() };
}

async function sendOtpEmail(email: string, code: string): Promise<void> {
  const env = getEnv();
  if (!env.smtpReady) throw new ApiError('OTP_DELIVERY_UNAVAILABLE', '邮件验证码暂不可用，请稍后重试', 503, true);
  const transporter = await getTransporter();
  await transporter.sendMail({
    from: parseSmtpFrom(env.smtp.from),
    to: email,
    subject: 'AnPPT 登录验证码',
    html: emailHtml(code),
  });
}

async function sendOtpSms(phone: string, code: string): Promise<void> {
  await sendSmsCode(phone, code);
}

export interface OtpRequestResult {
  challengeId: string;
  expiresAt: number;
  retryAfterSeconds: number;
  destination: string;
  devCode?: string;
}

export async function requestEmailOtp(identifier: unknown, clientIp: string): Promise<OtpRequestResult> {
  const id = classifyIdentifier(identifier);
  if (id.kind === 'username') throw validationError('请输入正确的邮箱地址或手机号');
  const env = getEnv();
  const secret = effectiveOtpSecret();
  const channelReady = id.kind === 'email' ? env.smtpReady : env.smsReady;
  if (!secret || (!channelReady && !env.otpDevEcho)) {
    throw new ApiError(
      'OTP_DELIVERY_UNAVAILABLE',
      id.kind === 'email' ? '邮件验证码暂不可用，请稍后重试' : '短信验证码暂不可用，请使用邮箱登录',
      503,
      true,
    );
  }

  const db = getDb();
  const ts = Date.now();
  const idHash = identifierHash(secret, id.value);
  const cHash = clientHash(secret, clientIp);

  const latest = db
    .prepare('SELECT created_at FROM auth_otp_challenges WHERE identifier_hash = ? ORDER BY created_at DESC LIMIT 1')
    .get(idHash);
  if (latest && ts - Number(latest.created_at) < OTP_COOLDOWN_MS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((OTP_COOLDOWN_MS - (ts - Number(latest.created_at))) / 1000));
    throw new ApiError('OTP_COOLDOWN', `请在 ${retryAfterSeconds} 秒后重新发送`, 429, true);
  }

  const since = ts - 60 * 60 * 1000;
  const identifierCount = Number(
    db.prepare('SELECT COUNT(*) AS c FROM auth_otp_challenges WHERE identifier_hash = ? AND created_at >= ?').get(idHash, since)?.c || 0,
  );
  const ipCount = Number(
    db.prepare('SELECT COUNT(*) AS c FROM auth_otp_challenges WHERE client_hash = ? AND created_at >= ?').get(cHash, since)?.c || 0,
  );
  if (identifierCount >= OTP_IDENTIFIER_HOURLY_MAX || ipCount >= OTP_CLIENT_HOURLY_MAX) {
    throw new ApiError('OTP_RATE_LIMITED', '验证码请求过多，请稍后再试', 429, true);
  }

  const challengeId = safeId('otp');
  const code = String(randomInt(100000, 1000000));
  const expiresAt = ts + OTP_TTL_MS;
  db.prepare(
    `INSERT INTO auth_otp_challenges
      (id, identifier_hash, code_hash, client_hash, expires_at, attempts, max_attempts, consumed_at, delivery_status, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
  ).run(
    challengeId,
    idHash,
    hmacHex(secret, `${challengeId}:${code}`),
    cHash,
    expiresAt,
    OTP_MAX_ATTEMPTS,
    env.otpDevEcho ? 'dev' : 'pending',
    ts,
  );

  if (!env.otpDevEcho) {
    try {
      if (id.kind === 'email') await sendOtpEmail(id.value, code);
      else await sendOtpSms(id.value, code);
      db.prepare('UPDATE auth_otp_challenges SET delivery_status = ? WHERE id = ?').run('sent', challengeId);
    } catch (error) {
      db.prepare('UPDATE auth_otp_challenges SET delivery_status = ? WHERE id = ?').run('failed', challengeId);
      logProblem({
        category: 'otp',
        level: 'error',
        message: id.kind === 'email' ? '邮件验证码发送失败' : '短信验证码发送失败',
        detail: error,
        refType: 'otp',
        refId: challengeId,
      });
      if (error instanceof ApiError) throw error;
      throw new ApiError('OTP_DELIVERY_FAILED', '验证码发送失败，请稍后重试', 503, true);
    }
  }

  db.prepare('DELETE FROM auth_otp_challenges WHERE expires_at < ?').run(ts - 24 * 60 * 60 * 1000);

  return {
    challengeId,
    expiresAt,
    retryAfterSeconds: Math.ceil(OTP_COOLDOWN_MS / 1000),
    destination: id.kind === 'email' ? maskEmail(id.value) : maskPhone(id.value),
    ...(env.otpDevEcho ? { devCode: code } : {}),
  };
}

export interface OtpVerifyResult extends AuthResult {
  isNewUser: boolean;
}

function deriveUsernameFromEmail(email: string): string {
  const local = email.split('@')[0] || '';
  let base = local.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (base.length < 3) base = `u_${base}`.padEnd(3, '_');
  base = base.slice(0, 28);
  const db = getDb();
  let candidate = base;
  for (let i = 0; i < 20; i += 1) {
    const taken = db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate);
    if (!taken) return candidate;
    candidate = `${base.slice(0, 24)}_${randomBytes(2).toString('hex')}`.slice(0, 32);
  }
  return `u_${randomBytes(8).toString('hex')}`;
}

function deriveUsernameFromPhone(phone: string): string {
  const db = getDb();
  const base = `u_${phone.slice(-4)}`;
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(base)) return base;
  for (let i = 0; i < 20; i += 1) {
    const candidate = `${base}_${randomBytes(2).toString('hex')}`;
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) return candidate;
  }
  return `u_${randomBytes(8).toString('hex')}`;
}

export async function verifyEmailOtp(input: { identifier: unknown; code: unknown; challengeId?: unknown }): Promise<OtpVerifyResult> {
  const id = classifyIdentifier(input.identifier);
  if (id.kind === 'username') throw validationError('请输入正确的邮箱地址或手机号');
  const code = String(input.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw validationError('请输入 6 位验证码');
  const secret = effectiveOtpSecret();
  if (!secret) throw new ApiError('OTP_NOT_CONFIGURED', '验证码登录暂不可用', 503, true);

  const db = getDb();
  const ts = Date.now();
  const idHash = identifierHash(secret, id.value);
  const challengeId = String(input.challengeId ?? '').trim();

  let isNewUser = false;

  const user = withTransaction(db, (): PublicUser => {
    const challenge = challengeId
      ? db.prepare('SELECT * FROM auth_otp_challenges WHERE id = ? AND identifier_hash = ?').get(challengeId, idHash)
      : db
          .prepare(
            `SELECT * FROM auth_otp_challenges WHERE identifier_hash = ? AND consumed_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get(idHash);

    const invalid = !challenge
      || challenge.consumed_at != null
      || Number(challenge.expires_at) <= ts
      || Number(challenge.attempts) >= Number(challenge.max_attempts)
      || !['sent', 'dev'].includes(String(challenge.delivery_status));
    if (invalid) {
      throw new ApiError('OTP_INVALID', '验证码不正确或已失效，请重新获取', 400, false);
    }

    const expected = Buffer.from(String(challenge.code_hash), 'hex');
    const actual = Buffer.from(hmacHex(secret, `${String(challenge.id)}:${code}`), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      db.prepare(
        `UPDATE auth_otp_challenges
         SET attempts = attempts + 1,
             consumed_at = CASE WHEN attempts + 1 >= max_attempts THEN ? ELSE consumed_at END
         WHERE id = ? AND consumed_at IS NULL`,
      ).run(ts, String(challenge.id));
      throw new ApiError('OTP_INVALID', '验证码不正确或已失效，请重新输入', 400, false);
    }

    const consumed = db
      .prepare('UPDATE auth_otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < max_attempts')
      .run(ts, String(challenge.id), ts);
    if (consumed.changes !== 1) {
      throw new ApiError('OTP_ALREADY_USED', '验证码已使用，请重新获取', 409, false);
    }

    const existing = id.kind === 'email' ? findUserByEmail(id.value) : findUserByPhone(id.value);
    if (existing) return existing;
    const isEmail = id.kind === 'email';
    const username = isEmail ? deriveUsernameFromEmail(id.value) : deriveUsernameFromPhone(id.value);
    const displayName = isEmail
      ? (id.value.split('@')[0] || 'AnPPT 用户').slice(0, 32)
      : `用户${id.value.slice(-4)}`;
    const created = createUserTx({
      username,
      email: isEmail ? id.value : null,
      phone: isEmail ? null : id.value,
      displayName,
      passwordHash: null,
    });
    grantSignupBonusTx(created.id);
    isNewUser = true;
    return created;
  });

  const sessionToken = createSessionForUser(user.id);
  return { user, sessionToken, isNewUser };
}
