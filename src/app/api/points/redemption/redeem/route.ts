import { defineRoute, jsonOk, readJsonBody, getClientIp } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { redeemCode } from '@/lib/server/redemption';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const { user } = requireUser(request);
  const body = await readJsonBody(request);
  return jsonOk(redeemCode(user.id, body.code, getClientIp(request)));
}, { mutation: true });
