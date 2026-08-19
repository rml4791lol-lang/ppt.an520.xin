import { defineRoute, jsonOk } from '@/lib/server/http';
import { getSessionFromRequest, buildSessionCookie } from '@/lib/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  const session = getSessionFromRequest(request);
  if (!session) return jsonOk({ authenticated: false, user: null });
  const headers = session.refreshed
    ? { 'Set-Cookie': buildSessionCookie(request, session.token) }
    : undefined;
  return jsonOk({ authenticated: true, user: session.user }, { headers });
});
