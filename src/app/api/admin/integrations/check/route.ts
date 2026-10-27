import { recordAdminAudit, requireAdmin } from '@/lib/server/admin';
import { checkAdminIntegration, type AdminIntegrationKind } from '@/lib/server/admin-integrations';
import { defineRoute, jsonOk, readJsonBody, validationError } from '@/lib/server/http';
import { adminIntentParams } from '@/lib/admin-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const { user } = requireAdmin(request);
  const body = readIntentParams(await readJsonBody(request), (intent) => adminIntentParams('checkIntegration', intent));
  const kind = String(body.kind || '') as AdminIntegrationKind;
  const values = body.values == null
    ? undefined
    : body.values && typeof body.values === 'object' && !Array.isArray(body.values)
      ? body.values as Record<string, unknown>
      : (() => { throw validationError('values 格式不正确'); })();
  const startedAt = Date.now();
  try {
    const result = await checkAdminIntegration(kind, values);
    recordAdminAudit({
      adminUserId: user.id,
      action: 'integration.check',
      targetType: 'integration',
      targetId: kind,
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
      targetId: kind,
      detail: { success: false, latencyMs: Date.now() - startedAt },
    });
    throw error;
  }
}, { mutation: true });
