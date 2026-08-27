// 当前用户视角的功能可见性地图（匿名按普通用户），前端据此隐藏未开放入口。
import { getSessionFromRequest } from '@/lib/server/auth';
import { jsonOk } from '@/lib/server/http';
import { featureVisibilityFor } from '@/lib/server/feature-flags';
import { defineApiRoute } from '@/lib/server/generation/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineApiRoute(async (request) => {
  const session = getSessionFromRequest(request);
  return jsonOk({ flags: featureVisibilityFor(session?.user ?? null) });
});
