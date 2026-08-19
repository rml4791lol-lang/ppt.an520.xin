import { defineRoute, jsonOk, readJsonBody, getClientIp } from '@/lib/server/http';
import { loginWithPassword, buildSessionCookie } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const body = await readJsonBody(request);
  const identifier = String(body.account ?? body.email ?? '');
  const result = await loginWithPassword(
    { identifier, password: typeof body.password === 'string' ? body.password : '' },
    getClientIp(request),
  );
  return jsonOk(
    { user: result.user },
    { headers: { 'Set-Cookie': buildSessionCookie(request, result.sessionToken) } },
  );
}, { mutation: true });
