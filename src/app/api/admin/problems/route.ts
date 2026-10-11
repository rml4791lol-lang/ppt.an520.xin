import { requireAdmin } from '@/lib/server/admin';
import { defineRoute, jsonOk } from '@/lib/server/http';
import { readProblems } from '@/lib/server/problem-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  requireAdmin(request);
  const params = new URL(request.url).searchParams;
  const items = readProblems({
    days: params.get('days'),
    category: params.get('category'),
    level: params.get('level'),
    limit: params.get('limit'),
  }).items;
  return jsonOk({ items }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
});
