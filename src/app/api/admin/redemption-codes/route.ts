import { recordAdminAudit, requireAdmin } from '@/lib/server/admin';
import { defineRoute, jsonOk, readJsonBody } from '@/lib/server/http';
import { generateRedemptionCodes } from '@/lib/server/redemption';
import { ADMIN_INTENT_PARAMS } from '@/lib/admin-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const { user } = requireAdmin(request);
  const { params: body } = readIntentParams(await readJsonBody(request), ADMIN_INTENT_PARAMS, 'generateRedemptionCodes');
  const credits = body.credits;
  const count = body.count ?? 1;
  const batch = body.batch ?? '';
  // 解析器把「空串 = 永久」统一成 null；这里只按 number/null 计算到期时间
  const expiresDays = typeof body.expiresDays === 'number' ? body.expiresDays : null;
  const expiresAt = expiresDays == null ? null : Date.now() + expiresDays * 24 * 60 * 60 * 1000;
  const codes = generateRedemptionCodes({ credits, count, batch, expiresAt });
  recordAdminAudit({
    adminUserId: user.id,
    action: 'redemption_codes.generate',
    targetType: 'redemption_batch',
    targetId: batch,
    detail: { credits, count, expiresAt },
  });
  return jsonOk({ codes, credits, count, batch, expiresAt }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}, { mutation: true });
