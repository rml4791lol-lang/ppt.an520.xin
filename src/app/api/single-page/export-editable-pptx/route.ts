import { jsonOk, validationError } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { startSinglePageEditableExport } from '@/lib/server/exports';
import { cleanString } from '@/lib/server/generation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页项目可编辑 PPTX 导出（20🌟/页，Codia 链）：建行扣费后后台转换，202 返回任务句柄 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const projectId = cleanString(body?.projectId, 80);
  if (!projectId) throw validationError('缺少 projectId');
  const started = await startSinglePageEditableExport(user.id, projectId);
  return jsonOk(
    {
      exportId: started.exportId,
      status: started.status,
      credits: started.credits,
      pageCount: started.pageCount,
    },
    { status: 202 },
  );
}, { mutation: true });
