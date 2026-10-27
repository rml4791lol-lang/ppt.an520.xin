import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { exportSinglePagesImagePptx } from '@/lib/server/exports';
import { singlePageIntentParams } from '@/lib/single-page-intents';
import { readActionParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页项目 → 图片版 PPTX（免费）：{projectId} 或 {pageIds:[...]} */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = readActionParams(await readJsonBody(request), (intent) => singlePageIntentParams('exportImagePptx', intent));
  const result = await exportSinglePagesImagePptx(user.id, {
    projectId: body.projectId ? String(body.projectId) : undefined,
    pageIds: Array.isArray(body.pageIds) ? body.pageIds.map(String) : undefined,
    title: body.title ? String(body.title) : undefined,
  });
  return jsonOk(result, { status: 201 });
}, { mutation: true });
