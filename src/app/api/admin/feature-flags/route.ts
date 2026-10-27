// 管理端功能开关板：GET 全量视图 / PUT 切换状态（off/beta/public）。
import { requireAdmin, recordAdminAudit } from '@/lib/server/admin';
import { ApiError, jsonOk } from '@/lib/server/http';
import { FEATURE_FLAG_DEFS, listFeatureFlags, setFeatureFlag, type FeatureFlagState } from '@/lib/server/feature-flags';
import { cleanString } from '@/lib/server/generation/types';
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
  const key = cleanString(body?.key, 60);
  const state = cleanString(body?.state, 20) as FeatureFlagState;
  if (!key || !FEATURE_FLAG_DEFS.some((def) => def.key === key)) {
    throw new ApiError('VALIDATION_ERROR', '未知的功能开关', 400, false);
  }
  setFeatureFlag(key, state, user.id);
  recordAdminAudit({
    adminUserId: user.id,
    action: 'feature-flag:set',
    targetType: 'feature_flag',
    targetId: key,
    detail: { state },
  });
  return jsonOk({ flags: listFeatureFlags() });
}, { mutation: true });
