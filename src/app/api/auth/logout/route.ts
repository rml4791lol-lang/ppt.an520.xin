import { defineRoute, jsonOk } from '@/lib/server/http';
import { getSessionFromRequest, revokeSession, buildClearSessionCookie } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const session = getSessionFromRequest(request);
  if (session) revokeSession(session.token);
  return jsonOk(
    { authenticated: false },
    { headers: { 'Set-Cookie': buildClearSessionCookie(request) } },
  );
}, { mutation: true });
