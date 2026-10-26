import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { assertFeatureVisible } from '@/lib/server/feature-flags';
import { defineApiRoute } from '@/lib/server/generation/route';
import { getSinglePageBatchDetail, startReplicateBatch } from '@/modules/ppt-replicate/server/batch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 启动 PPT 美化批量生成；同一项目已有在途任务时返回原任务。 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  assertFeatureVisible('ppt_replicate', user);
  const body = await readJsonBody(request);
  const batch = await startReplicateBatch(user.id, {
    projectId: body.projectId,
    pageIds: body.pageIds,
    colorMode: body.colorMode,
    structures: body.structures,
  });
  return jsonOk(batch, { status: 202 });
}, { mutation: true });

/** 轮询项目最新批量任务及当前页面图，不传 batchId 以支持刷新后自动续看。 */
export const GET = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  assertFeatureVisible('ppt_replicate', user);
  const projectId = new URL(request.url).searchParams.get('projectId') || '';
  return jsonOk(getSinglePageBatchDetail(user.id, projectId));
});
