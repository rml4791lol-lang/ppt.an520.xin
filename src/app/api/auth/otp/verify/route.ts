import { defineRoute, jsonOk, readJsonBody } from '@/lib/server/http';
import { verifyEmailOtp } from '@/lib/server/otp';
import { buildSessionCookie } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const body = await readJsonBody(request);
  const result = await verifyEmailOtp({
    identifier: body.identifier,
    code: body.code,
    challengeId: body.challengeId,
  });
  return jsonOk(
    { user: result.user, isNewUser: result.isNewUser },
    { headers: { 'Set-Cookie': buildSessionCookie(request, result.sessionToken) } },
  );
}, { mutation: true });
