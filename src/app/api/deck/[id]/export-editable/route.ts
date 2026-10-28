import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { deckEditableSource, startEditableExport } from '@/modules/editable-export/server/editable';
import { EXPORT_INTENT_PARAMS } from '@/lib/export-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 可编辑 PPTX 导出（20🌟/页，WPS 免费优先 / Image2PPT / Codia 备用）：建行扣费后后台转换，202 返回任务句柄 */
export const POST = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { params: body } = readIntentParams(raw, EXPORT_INTENT_PARAMS, 'exportDeckEditable');
  const started = await startEditableExport(deckEditableSource(user.id, id), 'editable', { force: body.force });
  return jsonOk(started, { status: started.status === 'succeeded' ? 200 : 202 });
}, { mutation: true });
