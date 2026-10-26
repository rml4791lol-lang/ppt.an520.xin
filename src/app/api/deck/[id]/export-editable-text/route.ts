import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { assertFeatureVisible } from '@/lib/server/feature-flags';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { startDeckTextEditableExport } from '@/modules/editable-export/server/editable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 轻量文字可编辑 PPTX 导出（5🌟/页，VLM 覆盖层链）：建行扣费后后台转换，202 返回任务句柄。
 *  开关功能 editable_text_overlay：对普通用户按 404 处理，不暴露功能存在。 */
export const POST = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  assertFeatureVisible('editable_text_overlay', user);
  const id = await paramOf(ctx, 'id');
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const started = await startDeckTextEditableExport(user.id, id, {}, { force: body.force === true });
  return jsonOk(
    {
      exportId: started.exportId,
      status: started.status,
      credits: started.credits,
      pageCount: started.pageCount,
      progress: started.progress,
      completedPages: started.completedPages,
      totalPages: started.totalPages,
      stage: started.stage,
      url: started.url,
      reused: started.reused,
    },
    { status: started.status === 'succeeded' ? 200 : 202 },
  );
}, { mutation: true });
