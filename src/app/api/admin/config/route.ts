import { listAdminConfigFields, updateAdminRuntimeConfig } from '@/lib/server/admin-config';
import { recordAdminAudit, requireAdmin } from '@/lib/server/admin';
import { defineRoute, jsonOk, readJsonBody, validationError } from '@/lib/server/http';
import { adminIntentParams } from '@/lib/admin-intents';
import { readActionParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  requireAdmin(request);
  return jsonOk(listAdminConfigFields(), {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
});

export const PUT = defineRoute(async (request) => {
  const { user } = requireAdmin(request);
  const body = readActionParams(await readJsonBody(request), (intent) => adminIntentParams('updateRuntimeConfig', intent));
  const values = body.values == null
    ? undefined
    : body.values && typeof body.values === 'object' && !Array.isArray(body.values)
      ? body.values as Record<string, unknown>
      : (() => { throw validationError('values 格式不正确'); })();
  const clearKeys = body.clearKeys == null
    ? undefined
    : Array.isArray(body.clearKeys)
      ? body.clearKeys
      : (() => { throw validationError('clearKeys 格式不正确'); })();
  const result = updateAdminRuntimeConfig({ adminUserId: user.id, values, clearKeys });
  recordAdminAudit({
    adminUserId: user.id,
    action: 'config.update',
    targetType: 'runtime_config',
    detail: {
      changedKeys: result.changedKeys,
      clearedKeys: result.clearedKeys,
    },
  });
  return jsonOk({ ...result, config: listAdminConfigFields() }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}, { mutation: true });
