// 设置/取消测试用户：POST {role:'tester'|'user'}。admin 角色升降不经过此口（保持手工）。
import { requireAdmin, recordAdminAudit } from '@/lib/server/admin';
import { findUserById } from '@/lib/server/auth';
import { getDb } from '@/lib/server/db';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { ApiError, jsonOk, readJsonBody } from '@/lib/server/http';
import { ADMIN_INTENT_PARAMS } from '@/lib/admin-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineApiRoute(async (request, ctx) => {
  const { user } = requireAdmin(request);
  const targetUserId = await paramOf(ctx, 'id');
  const { params: body } = readIntentParams(await readJsonBody(request), ADMIN_INTENT_PARAMS, 'setUserRole');
  const role = String(body.role ?? '');
  if (role !== 'tester' && role !== 'user') {
    throw new ApiError('VALIDATION_ERROR', 'role 只能是 tester 或 user', 400, false);
  }
  const target = findUserById(targetUserId);
  if (!target) throw new ApiError('NOT_FOUND', '用户不存在', 404, false);
  if (target.role === 'admin') {
    throw new ApiError('VALIDATION_ERROR', '管理员账号不经过测试用户开关', 400, false);
  }
  getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetUserId);
  recordAdminAudit({
    adminUserId: user.id,
    action: 'user:set-role',
    targetType: 'user',
    targetId: targetUserId,
    detail: { role, account: target.username },
  });
  return jsonOk({ userId: targetUserId, role });
}, { mutation: true });
