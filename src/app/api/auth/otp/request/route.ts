import { defineRoute, jsonOk, readJsonBody, getClientIp } from '@/lib/server/http';
import { requestEmailOtp } from '@/lib/server/otp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const body = await readJsonBody(request);
  const result = await requestEmailOtp(body.identifier, getClientIp(request));
  return jsonOk(result);
}, { mutation: true });
