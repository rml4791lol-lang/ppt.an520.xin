import { defineRoute, jsonOk } from '@/lib/server/http';
import { requireUser, buildSessionCookie } from '@/lib/server/auth';
import { getBalance } from '@/lib/server/credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FEATURES = {
  editableExport: false,
  pagedCopyV2: true,
  beautify: true,
} as const;

export const GET = defineRoute(async (request) => {
  const session = requireUser(request);
  const headers = session.refreshed
    ? { 'Set-Cookie': buildSessionCookie(request, session.token) }
    : undefined;
  return jsonOk(
    { user: session.user, features: FEATURES, balance: getBalance(session.user.id) },
    { headers },
  );
});
