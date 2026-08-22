import { randomBytes } from 'node:crypto';
import { requireUser, type PublicUser, type SessionInfo } from './auth';
import { getDb } from './db';
import { ApiError } from './http';

const SENSITIVE_KEY = /(secret|password|token|api.?key|authorization|cookie|credential|private.?key)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

function cleanId(value: unknown, max = 120): string {
  return String(value ?? '').trim().replace(/[\r\n\0]/g, '').slice(0, max);
}

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactAdminText(value, 500);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizeAuditValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeAuditValue(item, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 100);
}

export function redactAdminText(value: unknown, max = 240): string {
  return String(value ?? '')
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(/[\r\n\0]+/g, ' ')
    .trim()
    .slice(0, max);
}

export function isAdminUser(user: PublicUser | null | undefined): boolean {
  return user?.role === 'admin';
}

export function requireAdmin(request: Request): SessionInfo {
  const session = requireUser(request);
  if (!isAdminUser(session.user)) {
    throw new ApiError('ADMIN_FORBIDDEN', '仅管理员可以访问系统管理', 403, false);
  }
  return session;
}

export interface AdminAuditInput {
  adminUserId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

/**
 * 管理员审计不应反向阻断已经成功的业务操作，因此写入失败只记录服务端错误。
 * detail 会递归脱敏，密钥、令牌和 Authorization 永不落库。
 */
export function recordAdminAudit(input: AdminAuditInput): void {
  try {
    const safeDetail = sanitizeAuditValue(input.detail ?? {});
    let detailJson = JSON.stringify(safeDetail);
    if (detailJson.length > 8_000) detailJson = JSON.stringify({ truncated: true });
    getDb().prepare(
      `INSERT INTO admin_audit_logs
       (id, admin_user_id, action, target_type, target_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `audit_${randomBytes(12).toString('hex')}`,
      cleanId(input.adminUserId, 100) || null,
      cleanId(input.action, 100),
      cleanId(input.targetType, 60),
      cleanId(input.targetId, 160),
      detailJson,
      Date.now(),
    );
  } catch (error) {
    console.error('[anppt-v2][admin] 审计日志写入失败：', error instanceof Error ? error.message : error);
  }
}
