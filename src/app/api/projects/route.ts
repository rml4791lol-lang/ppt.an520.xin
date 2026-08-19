import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { listProjects } from '@/lib/server/generation/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 项目列表：?projectType=deck|single-page&page=&pageSize= */
export const GET = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const url = new URL(request.url);
  return jsonOk(
    listProjects(user.id, {
      projectType: url.searchParams.get('projectType') || undefined,
      page: Number(url.searchParams.get('page')) || 1,
      pageSize: Number(url.searchParams.get('pageSize')) || 20,
    }),
  );
});
