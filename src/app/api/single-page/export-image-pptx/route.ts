import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { exportSinglePagesImagePptx } from '@/lib/server/exports';
import { SINGLE_PAGE_INTENT_PARAMS } from '@/lib/single-page-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页项目 → 图片版 PPTX（免费）：{projectId} 或 {pageIds:[...]} */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const { params: body } = readIntentParams(await readJsonBody(request), SINGLE_PAGE_INTENT_PARAMS, 'exportImagePptx');
  const result = await exportSinglePagesImagePptx(user.id, {
    projectId: body.projectId || undefined,
    pageIds: body.pageIds,
    title: body.title || undefined,
  });
  return jsonOk(result, { status: 201 });
}, { mutation: true });
