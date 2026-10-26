import { defineRoute, jsonOk, readJsonBody, getClientIp } from '@/lib/server/http';
import { registerWithPassword, buildSessionCookie } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const body = await readJsonBody(request);
  const result = await registerWithPassword(
    {
      account: String(body.account ?? ''),
      password: typeof body.password === 'string' ? body.password : '',
      confirmPassword: typeof body.confirmPassword === 'string' ? body.confirmPassword : '',
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
    },
    getClientIp(request),
  );
  return jsonOk(
    { user: result.user },
    { status: 201, headers: { 'Set-Cookie': buildSessionCookie(request, result.sessionToken) } },
  );
}, { mutation: true });
