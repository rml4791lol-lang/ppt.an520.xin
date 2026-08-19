import { defineRoute, jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { getBalance } from '@/lib/server/credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  const { user } = requireUser(request);
  return jsonOk({ balance: getBalance(user.id) });
});
