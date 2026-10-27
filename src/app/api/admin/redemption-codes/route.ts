import { recordAdminAudit, requireAdmin } from '@/lib/server/admin';
import { defineRoute, jsonOk, readJsonBody, validationError } from '@/lib/server/http';
import { generateRedemptionCodes } from '@/lib/server/redemption';
import { adminIntentParams } from '@/lib/admin-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const { user } = requireAdmin(request);
  const body = readIntentParams(await readJsonBody(request), (intent) => adminIntentParams('generateRedemptionCodes', intent));
  const credits = Math.floor(Number(body.credits));
  const count = Math.floor(Number(body.count ?? 1));
  const expiresDays = body.expiresDays == null || body.expiresDays === ''
    ? null
    : Math.floor(Number(body.expiresDays));
  if (!Number.isSafeInteger(credits) || credits < 1 || credits > 1_000_000) {
    throw validationError('每张兑换码积分需为 1–1000000 的整数');
  }
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw validationError('单次生成数量需为 1–100');
  }
  if (expiresDays != null && (!Number.isSafeInteger(expiresDays) || expiresDays < 1 || expiresDays > 3650)) {
    throw validationError('有效期需为 1–3650 天');
  }
  const batch = String(body.batch ?? '').trim().slice(0, 64);
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
