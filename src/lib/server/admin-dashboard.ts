import { statfsSync, statSync } from 'node:fs';
import { isAdminConfigStorageReady } from './admin-config';
import { redactAdminText } from './admin';
import { getDb } from './db';
import { getEnv } from './env';
import { getGenerationConfig } from './generation/config';
import { getGenDb } from './generation/db';

const DAY_MS = 24 * 60 * 60 * 1000;

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

function userSnapshot(userId: string): AdminUserSnapshot | null {
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
    accountHealthy: numberOf(user, 'balance') >= 0,
  };
}

export function listLatestUsers(limit = 12): AdminUserSnapshot[] {
  const boundedLimit = Math.min(30, Math.max(1, Math.floor(limit)));
  const rows = getGenDb().prepare(
    `SELECT u.id FROM users u ORDER BY u.created_at DESC LIMIT ?`,
  ).all(boundedLimit) as Row[];
  return rows
    .map((row) => userSnapshot(String(row.id)))
    .filter((item): item is AdminUserSnapshot => Boolean(item));
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
       (SELECT COUNT(*) FROM generation_jobs WHERE status IN ('queued', 'running'))
         + (SELECT COUNT(*) FROM single_page_batches WHERE status IN ('queued', 'running')) AS active_generation,
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
    editable: Boolean(generation.image2pptApiKey || generation.wpsAipptCookie || (generation.codiaBaseUrl && generation.codiaApiKey)),
    smtp: env.smtpReady,
    sms: env.smsReady,
    payment: wechatReady || epayReady,
    adminConfigStorage: isAdminConfigStorageReady(),
  };
  overview.audits = listAudits();
  return overview;
}
