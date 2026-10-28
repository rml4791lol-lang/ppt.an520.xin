// 管理端功能开关板：GET 全量视图 / PUT 切换状态（off/beta/public）。
import { requireAdmin, recordAdminAudit } from '@/lib/server/admin';
import { ApiError, jsonOk } from '@/lib/server/http';
import { FEATURE_FLAG_DEFS, listFeatureFlags, setFeatureFlag } from '@/lib/server/feature-flags';
import { defineApiRoute } from '@/lib/server/generation/route';
import { ADMIN_INTENT_PARAMS } from '@/lib/admin-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineApiRoute(async (request) => {
  requireAdmin(request);
  return jsonOk({ flags: listFeatureFlags() });
});

export const PUT = defineApiRoute(async (request) => {
  const { user } = requireAdmin(request);
  const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { params: body } = readIntentParams(raw, ADMIN_INTENT_PARAMS, 'setFeatureFlag');
  if (!body.key || !FEATURE_FLAG_DEFS.some((def) => def.key === body.key)) {
    throw new ApiError('VALIDATION_ERROR', '未知的功能开关', 400, false);
  }
  setFeatureFlag(body.key, body.state, user.id);
  recordAdminAudit({
    adminUserId: user.id,
    action: 'feature-flag:set',
    targetType: 'feature_flag',
    targetId: body.key,
    detail: { state: body.state },
  });
  return jsonOk({ flags: listFeatureFlags() });
}, { mutation: true });
