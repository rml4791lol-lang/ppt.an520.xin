import { requireAdmin } from '@/lib/server/admin';
import { getAdminOverview } from '@/lib/server/admin-dashboard';
import { defineRoute, jsonOk } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  requireAdmin(request);
  const compact = new URL(request.url).searchParams.get('compact') === '1';
  return jsonOk(getAdminOverview(compact), {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
});
