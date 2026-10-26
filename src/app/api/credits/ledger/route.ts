import { defineRoute, jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { listLedger } from '@/lib/server/credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  const { user } = requireUser(request);
  const url = new URL(request.url);
  const result = listLedger(user.id, {
    page: Number(url.searchParams.get('page') || 1),
    pageSize: Number(url.searchParams.get('pageSize') || 20),
  });
  return jsonOk(result);
});
