import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { getDb, withTransaction, isUniqueViolation } from './db';
import { getEnv } from './env';
import { ApiError, validationError } from './http';
import { grantSignupBonusTx } from './credits';
import { hitRateLimit, resetRateLimit } from './rate-limit';

const scrypt = promisify(scryptCallback);
const PASSWORD_PREFIX = 'scrypt:v1';
const SESSION_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_ACCOUNT_MAX = 8;
const AUTH_CLIENT_MAX = 40;

const RESERVED_USERNAMES = new Set(['admin', 'root', 'system', 'support', 'api']);

export interface PublicUser {
  id: string;
  username: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  role: string;
  plan: string;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface AuthResult {
  user: PublicUser;
  sessionToken: string;
}

function now(): number {
  return Date.now();
}

export function sha256(value: string): string {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function normalizeUsername(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export function normalizeEmail(value: unknown): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw validationError('请输入正确的邮箱地址');
  }
  return email;
}

// 中国大陆手机号：容忍 +86/86 前缀与空格/短横分隔
export function normalizePhone(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/[\s-]+/g, '');
  const national = raw.replace(/^\+?86(?=1[3-9]\d{9}$)/, '');
  if (!/^1[3-9]\d{9}$/.test(national)) {
    throw validationError('请输入正确的手机号');
  }
  return national;
}

// 登录标识分类：邮箱 / 手机号 / 用户名
export type IdentifierKind = 'email' | 'phone' | 'username';

export function classifyIdentifier(value: unknown): { kind: IdentifierKind; value: string } {
  const trimmed = String(value ?? '').trim();
  if (trimmed.includes('@')) return { kind: 'email', value: normalizeEmail(trimmed) };
  const digits = trimmed.replace(/[\s-]+/g, '').replace(/^\+?86(?=1[3-9]\d{9}$)/, '');
  if (/^1[3-9]\d{9}$/.test(digits)) return { kind: 'phone', value: digits };
  return { kind: 'username', value: normalizeUsername(trimmed) };
}

function validateUsername(username: string): void {
  if (!username) throw validationError('请输入用户名');
  if (username.length < 3 || username.length > 32) throw validationError('用户名需 3–32 个字符');
  if (!/^[a-z0-9_]+$/.test(username)) throw validationError('用户名只能包含小写字母、数字和下划线');
  if (RESERVED_USERNAMES.has(username)) throw validationError('该用户名不可用');
}

function validatePassword(password: string): void {
  if (!password) throw validationError('请输入密码');
  if (password.length < 8) throw validationError('密码至少 8 位');
  if (password.length > 128) throw validationError('密码过长');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(String(password), salt, 32)) as Buffer;
  return `${PASSWORD_PREFIX}:${salt.toString('hex')}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = String(encoded || '').split(':');
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== PASSWORD_PREFIX) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (salt.length !== 16 || expected.length < 16) return false;
  const actual = Buffer.from((await scrypt(String(password), salt, expected.length)) as Buffer);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type UserRow = Record<string, string | number | null>;

function toPublicUser(row: UserRow | undefined | null): PublicUser | null {
  if (!row) return null;
  return {
    id: String(row.id),
    username: String(row.username),
    email: row.email == null ? null : String(row.email),
    phone: row.phone == null ? null : String(row.phone),
    displayName: String(row.display_name || row.username),
    role: String(row.role || 'user'),
    plan: String(row.plan || 'free'),
    createdAt: Number(row.created_at),
    lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
  };
}

export function findUserByUsername(username: string): PublicUser | null {
  const row = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  return toPublicUser(row as UserRow | undefined);
}

export function findUserByEmail(email: string): PublicUser | null {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  return toPublicUser(row as UserRow | undefined);
}

export function findUserByPhone(phone: string): PublicUser | null {
  const row = getDb().prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  return toPublicUser(row as UserRow | undefined);
}

export function findUserById(id: string): PublicUser | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return toPublicUser(row as UserRow | undefined);
}

function getPasswordHash(userId: string): string {
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  return String(row?.password_hash || '');
}

interface InsertUserInput {
  username: string;
  email: string | null;
  phone?: string | null;
  displayName: string;
  passwordHash: string | null;
}

export function createUserTx(input: InsertUserInput): PublicUser {
  const ts = now();
  const id = safeId('user');
  try {
    getDb()
      .prepare(
        `INSERT INTO users (id, username, email, phone, display_name, password_hash, role, plan, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, 'user', 'free', ?, NULL)`,
      )
      .run(id, input.username, input.email, input.phone ?? null, input.displayName, input.passwordHash, ts);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError('REGISTER_FAILED', '无法创建该账号，用户名、邮箱或手机号可能已被占用', 409, false);
    }
    throw error;
  }
  const user = findUserById(id);
  if (!user) throw new ApiError('INTERNAL_ERROR', '创建账号失败', 500, true);
  return user;
}

// --- session ---

export function createSessionForUser(userId: string): string {
  const env = getEnv();
  const ts = now();
  const token = `sess_${randomBytes(32).toString('base64url')}`;
  getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ts, userId);
  getDb()
    .prepare(
      `INSERT INTO auth_sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(safeId('session'), sha256(token), userId, ts, ts + env.sessionTtlMs, ts);
  return token;
}

function parseCookieHeader(request: Request): Map<string, string> {
  const header = request.headers.get('cookie') || '';
  const cookies = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (cookies.has(key)) continue;
    const value = part.slice(eq + 1).trim();
    try {
      cookies.set(key, decodeURIComponent(value));
    } catch {
      cookies.set(key, value);
    }
  }
  return cookies;
}

export interface SessionInfo {
  user: PublicUser;
  token: string;
  refreshed: boolean;
}

export function getSessionFromRequest(request: Request): SessionInfo | null {
  const env = getEnv();
  const token = parseCookieHeader(request).get(env.sessionCookieName);
  if (!token) return null;
  return getSessionByToken(token);
}

export function getSessionByToken(token: string): SessionInfo | null {
  const env = getEnv();
  const ts = now();
  const row = getDb()
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.*
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
    )
    .get(sha256(token), ts);
  const user = toPublicUser(row as UserRow | undefined);
  if (!row || !user) return null;
  let refreshed = false;
  if (ts - Number(row.last_seen_at) > SESSION_REFRESH_THRESHOLD_MS) {
    getDb()
      .prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
      .run(ts, ts + env.sessionTtlMs, String(row.session_id));
    refreshed = true;
  }
  return { user, token, refreshed };
}

export function requireUser(request: Request): SessionInfo {
  const session = getSessionFromRequest(request);
  if (!session) throw new ApiError('UNAUTHORIZED', '请先登录', 401, false);
  return session;
}

export function revokeSession(token: string): void {
  getDb().prepare('UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?').run(now(), sha256(token));
}

// --- cookies ---

function shouldUseSecureCookie(request: Request): boolean {
  const mode = getEnv().cookieSecure;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto) return proto === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function buildSessionCookie(request: Request, token: string): string {
  const env = getEnv();
  const parts = [
    `${env.sessionCookieName}=${encodeURIComponent(token)}`,
    `Max-Age=${Math.floor(env.sessionTtlMs / 1000)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (shouldUseSecureCookie(request)) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearSessionCookie(request: Request): string {
  const env = getEnv();
  const parts = [`${env.sessionCookieName}=`, 'Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (shouldUseSecureCookie(request)) parts.push('Secure');
  return parts.join('; ');
}

// --- rate limiting ---

function checkAuthRateLimit(clientIp: string, bucket: string, message: string): void {
  const client = hitRateLimit(`auth:ip:${clientIp}`, { windowMs: AUTH_WINDOW_MS, max: AUTH_CLIENT_MAX });
  const account = hitRateLimit(`auth:acct:${clientIp}:${bucket}`, { windowMs: AUTH_WINDOW_MS, max: AUTH_ACCOUNT_MAX });
  if (!client.allowed || !account.allowed) {
    throw new ApiError('AUTH_RATE_LIMITED', message, 429, true);
  }
}

// --- flows ---

export interface RegisterInput {
  account: string;
  password: string;
  confirmPassword: string;
  displayName?: string;
  email?: string;
}

export async function registerWithPassword(input: RegisterInput, clientIp: string): Promise<AuthResult> {
  const username = normalizeUsername(input.account);
  const password = typeof input.password === 'string' ? input.password : '';
  const confirmPassword = typeof input.confirmPassword === 'string' ? input.confirmPassword : password;
  validateUsername(username);
  validatePassword(password);
  if (password !== confirmPassword) throw validationError('两次输入的密码不一致');
  const email = String(input.email ?? '').trim() ? normalizeEmail(input.email) : null;
  checkAuthRateLimit(clientIp, `register:${username}`, '注册尝试过多，请稍后再试');

  const displayName = String(input.displayName ?? '').trim().slice(0, 32) || username;
  const passwordHash = await hashPassword(password);
  const db = getDb();
  const user = withTransaction(db, () => {
    const created = createUserTx({ username, email, displayName, passwordHash });
    grantSignupBonusTx(created.id);
    return created;
  });
  resetRateLimit(`auth:acct:${clientIp}:register:${username}`);
  const sessionToken = createSessionForUser(user.id);
  return { user, sessionToken };
}

export interface LoginInput {
  identifier: string;
  password: string;
}

let fakePasswordHashPromise: Promise<string> | null = null;

function fakePasswordHash(): Promise<string> {
  if (!fakePasswordHashPromise) fakePasswordHashPromise = hashPassword(randomBytes(16).toString('hex'));
  return fakePasswordHashPromise;
}

export async function loginWithPassword(input: LoginInput, clientIp: string): Promise<AuthResult> {
  const identifier = String(input.identifier ?? '').trim().toLowerCase();
  const password = typeof input.password === 'string' ? input.password : '';
  if (!identifier || !password) throw validationError('请输入账号和密码');
  checkAuthRateLimit(clientIp, `login:${identifier}`, '登录尝试过多，请稍后再试');

  const user = (() => {
    const id = classifyIdentifier(identifier);
    if (id.kind === 'email') return findUserByEmail(id.value);
    if (id.kind === 'phone') return findUserByPhone(id.value);
    return findUserByUsername(id.value);
  })();
  const storedHash = user ? getPasswordHash(user.id) : '';
  const ok = await verifyPassword(password, storedHash || (await fakePasswordHash()));
  if (!user || !ok) {
    throw new ApiError('AUTH_FAILED', '账号或密码不正确', 401, false);
  }
  resetRateLimit(`auth:acct:${clientIp}:login:${identifier}`);
  const sessionToken = createSessionForUser(user.id);
  return { user, sessionToken };
}
