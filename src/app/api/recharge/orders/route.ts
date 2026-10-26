import { defineRoute, jsonOk, readJsonBody, getClientIp } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { createRechargeOrder, getRechargeOrderForUser } from '@/lib/server/recharge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  const { user } = requireUser(request);
  const url = new URL(request.url);
  const order = getRechargeOrderForUser(user.id, url.searchParams.get('orderNo'));
  return jsonOk({ order });
});

export const POST = defineRoute(async (request) => {
  const { user } = requireUser(request);
  const body = await readJsonBody(request);
  const result = await createRechargeOrder(
    user.id,
    { planId: body.planId, channel: body.channel },
    getClientIp(request),
  );
  return jsonOk(result, { status: 201 });
}, { mutation: true });
