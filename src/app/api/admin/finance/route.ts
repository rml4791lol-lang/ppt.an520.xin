import { requireAdmin } from '@/lib/server/admin';
import { getFinanceStats } from '@/lib/server/finance-stats';
import { defineRoute, jsonOk } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  requireAdmin(request);
  return jsonOk(await getFinanceStats(), {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
});
