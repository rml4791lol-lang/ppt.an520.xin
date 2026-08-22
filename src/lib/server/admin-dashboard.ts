import { statfsSync, statSync } from 'node:fs';
import { findUserById } from './auth';
import { isAdminConfigStorageReady } from './admin-config';
import { redactAdminText, recordAdminAudit } from './admin';
import { getDb } from './db';
import { getEnv } from './env';
import { getGenerationConfig } from './generation/config';
import { getGenDb } from './generation/db';
import { ApiError, validationError } from './http';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WATCHED_USERS = 20;

type Row = Record<string, string | number | null>;

export interface AdminTaskSnapshot {
  kind: 'generation' | 'export';
  status: string;
  label: string;
  progress: number;
  error: string;
  updatedAt: number;
}

export interface AdminUserSnapshot {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  plan: string;
  balance: number;
  createdAt: number;
  lastLoginAt: number | null;
  activeSessions: number;
  projectCount: number;
  activeJobs: number;
  failures24h: number;
  redeemedCredits: number;
  lastActivityAt: number | null;
  lastActivityLabel: string;
  lastTask: AdminTaskSnapshot | null;
  watched: boolean;
  watchLabel: string;
  accountHealthy: boolean;
}

export interface AdminAuditView {
  id: string;
  adminLabel: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  createdAt: number;
}

export interface AdminOverview {
  generatedAt: number;
  compact: boolean;
  metrics: {
    totalUsers: number;
    newUsers24h: number;
    activeGenerationJobs: number;
    activeExportJobs: number;
    failures24h: number;
    totalProjects: number;
  };
  watchedUsers: AdminUserSnapshot[];
  latestUsers?: AdminUserSnapshot[];
  resources?: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    diskFreeBytes: number | null;
    diskTotalBytes: number | null;
    databaseBytes: number | null;
  };
  integrations?: {
    llm: boolean;
    image: boolean;
    editable: boolean;
    smtp: boolean;
    sms: boolean;
    payment: boolean;
    adminConfigStorage: boolean;
  };
  audits?: AdminAuditView[];
}

function numberOf(row: Row | undefined, key: string): number {
  return Number(row?.[key] ?? 0) || 0;
}

function safeDetail(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function latestTaskForUser(userId: string): AdminTaskSnapshot | null {
  const db = getGenDb();
  const generation = db.prepare(
    `SELECT kind, status, total, succeeded, failed, error, updated_at
     FROM generation_jobs WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
  ).get(userId) as Row | undefined;
  const exportJob = db.prepare(
    `SELECT kind, status, page_count, progress, completed_pages, stage, error, updated_at, created_at
     FROM export_jobs WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
  ).get(userId) as Row | undefined;
  const generationAt = numberOf(generation, 'updated_at');
  const exportAt = numberOf(exportJob, 'updated_at') || numberOf(exportJob, 'created_at');
  if (!generation && !exportJob) return null;
  if (exportJob && exportAt >= generationAt) {
    const pageCount = numberOf(exportJob, 'page_count');
    const completed = numberOf(exportJob, 'completed_pages');
    const explicitProgress = numberOf(exportJob, 'progress');
    return {
      kind: 'export',
      status: String(exportJob.status || ''),
      label: String(exportJob.kind || '') === 'editable' ? '转可编辑 PPT' : '导出文件',
      progress: Math.min(100, Math.max(explicitProgress, pageCount > 0 ? Math.round((completed / pageCount) * 100) : 0)),
      error: redactAdminText(exportJob.error, 180),
      updatedAt: exportAt,
    };
  }
  const total = numberOf(generation, 'total');
  const completed = numberOf(generation, 'succeeded') + numberOf(generation, 'failed');
  return {
    kind: 'generation',
    status: String(generation?.status || ''),
    label: String(generation?.kind || '') === 'single-page' ? '单页生成' : 'PPT 生成',
    progress: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0,
    error: redactAdminText(generation?.error, 180),
    updatedAt: generationAt,
  };
}

function userSnapshot(userId: string, watched: boolean, watchLabel = ''): AdminUserSnapshot | null {
  const db = getGenDb();
  const user = db.prepare(
    `SELECT u.id, u.username, u.email, u.display_name, u.role, u.plan, u.created_at, u.last_login_at,
       COALESCE(cw.balance, 0) AS balance
     FROM users u LEFT JOIN credit_wallets cw ON cw.user_id = u.id WHERE u.id = ?`,
  ).get(userId) as Row | undefined;
  if (!user) return null;
  const since = Date.now() - DAY_MS;
  const projects = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM decks WHERE user_id = ? AND deleted_at IS NULL)
       + (SELECT COUNT(*) FROM single_page_projects WHERE user_id = ? AND deleted_at IS NULL) AS count`,
  ).get(userId, userId) as Row | undefined;
  const jobs = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM generation_jobs WHERE user_id = ? AND status IN ('queued', 'running'))
       + (SELECT COUNT(*) FROM export_jobs WHERE user_id = ? AND status IN ('pending', 'processing')) AS active,
       (SELECT COUNT(*) FROM generation_jobs WHERE user_id = ? AND status = 'failed' AND updated_at >= ?)
       + (SELECT COUNT(*) FROM export_jobs WHERE user_id = ? AND status = 'failed' AND updated_at >= ?) AS failed`,
  ).get(userId, userId, userId, since, userId, since) as Row | undefined;
  const sessions = db.prepare(
    `SELECT COUNT(*) AS count FROM auth_sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  ).get(userId, Date.now()) as Row | undefined;
  const redemption = db.prepare(
    'SELECT COALESCE(SUM(credits), 0) AS credits FROM redemption_records WHERE user_id = ?',
  ).get(userId) as Row | undefined;
  const activity = db.prepare(
    `SELECT event_type, reason, created_at FROM credit_ledger
     WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(userId) as Row | undefined;

  return {
    id: String(user.id),
    username: String(user.username),
    displayName: String(user.display_name || user.username),
    email: user.email == null ? null : String(user.email),
    role: String(user.role || 'user'),
    plan: String(user.plan || 'free'),
    balance: numberOf(user, 'balance'),
    createdAt: numberOf(user, 'created_at'),
    lastLoginAt: user.last_login_at == null ? null : Number(user.last_login_at),
    activeSessions: numberOf(sessions, 'count'),
    projectCount: numberOf(projects, 'count'),
    activeJobs: numberOf(jobs, 'active'),
    failures24h: numberOf(jobs, 'failed'),
    redeemedCredits: numberOf(redemption, 'credits'),
    lastActivityAt: activity ? numberOf(activity, 'created_at') : null,
    lastActivityLabel: activity ? redactAdminText(activity.reason || activity.event_type, 100) : '暂无积分动态',
    lastTask: latestTaskForUser(userId),
    watched,
    watchLabel: redactAdminText(watchLabel, 80),
    accountHealthy: numberOf(user, 'balance') >= 0,
  };
}

export function listWatchedUsers(): AdminUserSnapshot[] {
  const rows = getGenDb().prepare(
    `SELECT aw.user_id, aw.label FROM admin_user_watches aw
     JOIN users u ON u.id = aw.user_id
     ORDER BY aw.created_at DESC LIMIT ?`,
  ).all(MAX_WATCHED_USERS) as Row[];
  return rows
    .map((row) => userSnapshot(String(row.user_id), true, String(row.label || '')))
    .filter((item): item is AdminUserSnapshot => Boolean(item));
}

export function listLatestUsers(limit = 12): AdminUserSnapshot[] {
  const boundedLimit = Math.min(30, Math.max(1, Math.floor(limit)));
  const rows = getGenDb().prepare(
    `SELECT u.id, aw.label AS watch_label FROM users u
     LEFT JOIN admin_user_watches aw ON aw.user_id = u.id
     ORDER BY u.created_at DESC LIMIT ?`,
  ).all(boundedLimit) as Row[];
  return rows
    .map((row) => userSnapshot(String(row.id), row.watch_label != null, String(row.watch_label || '')))
    .filter((item): item is AdminUserSnapshot => Boolean(item));
}

export function watchAdminUser(input: {
  adminUserId: string;
  targetUserId: string;
  label?: string;
}): AdminUserSnapshot {
  const targetUserId = String(input.targetUserId || '').trim();
  if (!targetUserId || !findUserById(targetUserId)) throw new ApiError('USER_NOT_FOUND', '用户不存在', 404, false);
  const label = redactAdminText(input.label, 80);
  getDb().prepare(
    `INSERT INTO admin_user_watches (user_id, label, created_by, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET label=excluded.label, created_by=excluded.created_by`,
  ).run(targetUserId, label, input.adminUserId, Date.now());
  recordAdminAudit({
    adminUserId: input.adminUserId,
    action: 'user.watch',
    targetType: 'user',
    targetId: targetUserId,
    detail: { label },
  });
  const snapshot = userSnapshot(targetUserId, true, label);
  if (!snapshot) throw new ApiError('USER_NOT_FOUND', '用户不存在', 404, false);
  return snapshot;
}

export function unwatchAdminUser(input: { adminUserId: string; targetUserId: string }): void {
  const targetUserId = String(input.targetUserId || '').trim();
  if (!targetUserId) throw validationError('缺少用户 ID');
  getDb().prepare('DELETE FROM admin_user_watches WHERE user_id = ?').run(targetUserId);
  recordAdminAudit({
    adminUserId: input.adminUserId,
    action: 'user.unwatch',
    targetType: 'user',
    targetId: targetUserId,
  });
}

function listAudits(limit = 30): AdminAuditView[] {
  const rows = getDb().prepare(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.detail_json, a.created_at,
       COALESCE(u.display_name, u.email, u.username, '已删除管理员') AS admin_label
     FROM admin_audit_logs a LEFT JOIN users u ON u.id = a.admin_user_id
     ORDER BY a.created_at DESC LIMIT ?`,
  ).all(Math.min(50, Math.max(1, limit))) as Row[];
  return rows.map((row) => {
    let detail: Record<string, unknown> = {};
    try {
      detail = safeDetail(JSON.parse(String(row.detail_json || '{}')));
    } catch {
      detail = {};
    }
    return {
      id: String(row.id),
      adminLabel: String(row.admin_label || '管理员'),
      action: String(row.action || ''),
      targetType: String(row.target_type || ''),
      targetId: String(row.target_id || ''),
      detail,
      createdAt: numberOf(row, 'created_at'),
    };
  });
}

function diskStats(dataDir: string): { free: number | null; total: number | null } {
  try {
    const stats = statfsSync(dataDir);
    return {
      free: Number(stats.bavail) * Number(stats.bsize),
      total: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return { free: null, total: null };
  }
}

export function getAdminOverview(compact = false): AdminOverview {
  const db = getGenDb();
  const since = Date.now() - DAY_MS;
  const metrics = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users) AS total_users,
       (SELECT COUNT(*) FROM users WHERE created_at >= ?) AS new_users,
       (SELECT COUNT(*) FROM generation_jobs WHERE status IN ('queued', 'running')) AS active_generation,
       (SELECT COUNT(*) FROM export_jobs WHERE status IN ('pending', 'processing')) AS active_export,
       (SELECT COUNT(*) FROM generation_jobs WHERE status = 'failed' AND updated_at >= ?)
         + (SELECT COUNT(*) FROM export_jobs WHERE status = 'failed' AND updated_at >= ?) AS failures,
       (SELECT COUNT(*) FROM decks WHERE deleted_at IS NULL)
         + (SELECT COUNT(*) FROM single_page_projects WHERE deleted_at IS NULL) AS projects`,
  ).get(since, since, since) as Row;

  const overview: AdminOverview = {
    generatedAt: Date.now(),
    compact,
    metrics: {
      totalUsers: numberOf(metrics, 'total_users'),
      newUsers24h: numberOf(metrics, 'new_users'),
      activeGenerationJobs: numberOf(metrics, 'active_generation'),
      activeExportJobs: numberOf(metrics, 'active_export'),
      failures24h: numberOf(metrics, 'failures'),
      totalProjects: numberOf(metrics, 'projects'),
    },
    watchedUsers: listWatchedUsers(),
  };
  if (compact) return overview;

  const memory = process.memoryUsage();
  const env = getEnv();
  const generation = getGenerationConfig();
  const disk = diskStats(generation.dataDir);
  let databaseBytes: number | null = null;
  try {
    databaseBytes = statSync(env.dbPath).size;
  } catch {
    databaseBytes = null;
  }
  const wechatReady = env.wechat.enabled
    && (env.wechat.mock || Boolean(env.wechat.mchId && env.wechat.appId && env.wechat.apiV3Key));
  const epayReady = env.epay.enabled
    && (env.epay.mock || Boolean(env.epay.gateway && env.epay.pid && env.epay.key));
  overview.latestUsers = listLatestUsers();
  overview.resources = {
    uptimeSeconds: Math.floor(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    diskFreeBytes: disk.free,
    diskTotalBytes: disk.total,
    databaseBytes,
  };
  overview.integrations = {
    llm: Boolean(generation.llmBaseUrl && generation.llmApiKey && generation.llmModel),
    image: Boolean(generation.imageBaseUrl && generation.imageApiKey && generation.imageModel),
    editable: Boolean(generation.codiaBaseUrl && generation.codiaApiKey),
    smtp: env.smtpReady,
    sms: env.smsReady,
    payment: wechatReady || epayReady,
    adminConfigStorage: isAdminConfigStorageReady(),
  };
  overview.audits = listAudits();
  return overview;
}
