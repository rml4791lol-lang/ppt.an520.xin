import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { singlePageEditableSource, startEditableExport } from '@/modules/editable-export/server/editable';
import { SINGLE_PAGE_INTENT_PARAMS } from '@/lib/single-page-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页项目可编辑 PPTX 导出（20🌟/页，WPS 免费优先 / Image2PPT / Codia 备用）：建行扣费后后台转换，202 返回任务句柄 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { params: body } = readIntentParams(raw, SINGLE_PAGE_INTENT_PARAMS, 'exportEditablePptx');
  const started = await startEditableExport(
    singlePageEditableSource(user.id, body.projectId),
    'editable',
    { force: body.force },
  );
  return jsonOk(started, { status: started.status === 'succeeded' ? 200 : 202 });
}, { mutation: true });
