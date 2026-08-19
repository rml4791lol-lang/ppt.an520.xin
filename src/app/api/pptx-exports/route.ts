import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { listExports } from '@/lib/server/exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 导出中心列表 */
export const GET = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const url = new URL(request.url);
  return jsonOk(
    listExports(user.id, {
      page: Number(url.searchParams.get('page')) || 1,
      pageSize: Number(url.searchParams.get('pageSize')) || 20,
    }),
  );
});
