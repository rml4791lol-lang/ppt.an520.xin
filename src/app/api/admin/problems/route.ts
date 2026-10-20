import { requireAdmin } from '@/lib/server/admin';
import { defineRoute, jsonOk } from '@/lib/server/http';
import { getProblemLogHealth, readProblems } from '@/lib/server/problem-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  requireAdmin(request);
  const params = new URL(request.url).searchParams;
  const problems = readProblems({
    days: params.get('days'),
    category: params.get('category'),
    level: params.get('level'),
    limit: params.get('limit'),
    offset: params.get('offset'),
  });
  return jsonOk({ ...problems, health: getProblemLogHealth() }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
});
