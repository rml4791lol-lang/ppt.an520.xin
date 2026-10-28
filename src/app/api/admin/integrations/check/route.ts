import { recordAdminAudit, requireAdmin } from '@/lib/server/admin';
import { checkAdminIntegration } from '@/lib/server/admin-integrations';
import { defineRoute, jsonOk, readJsonBody } from '@/lib/server/http';
import { ADMIN_INTENT_PARAMS } from '@/lib/admin-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const { user } = requireAdmin(request);
  const { params: body } = readIntentParams(await readJsonBody(request), ADMIN_INTENT_PARAMS, 'checkIntegration');
  const startedAt = Date.now();
  try {
    const result = await checkAdminIntegration(body.kind, body.values);
    recordAdminAudit({
      adminUserId: user.id,
      action: 'integration.check',
      targetType: 'integration',
      targetId: body.kind,
      detail: { success: true, latencyMs: result.latencyMs },
    });
    return jsonOk(result, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch (error) {
    recordAdminAudit({
      adminUserId: user.id,
      action: 'integration.check',
      targetType: 'integration',
      targetId: body.kind,
      detail: { success: false, latencyMs: Date.now() - startedAt },
    });
    throw error;
  }
}, { mutation: true });
