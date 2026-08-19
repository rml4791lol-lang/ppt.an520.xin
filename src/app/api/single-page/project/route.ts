import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { getSingleProjectDetail } from '@/lib/server/generation/single-pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页项目详情（含页面 + 版本列表）：?projectId= 恢复工作台用 */
export const GET = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const projectId = new URL(request.url).searchParams.get('projectId');
  return jsonOk(getSingleProjectDetail(user.id, projectId ?? ''));
});
