import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { refineSinglePage } from '@/lib/server/generation/single-pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页对话式改图（i2i）：{pageId, editInstruction, requestId?} */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = await readJsonBody(request);
  const result = await refineSinglePage(user.id, {
    pageId: String(body.pageId ?? ''),
    editInstruction: String(body.editInstruction ?? ''),
    requestId: body.requestId ? String(body.requestId) : undefined,
  });
  return jsonOk(
    {
      pageId: result.page.pageId,
      projectId: result.page.projectId,
      jobId: result.jobId,
      versionId: result.versionId,
      status: result.status,
      imageUrl: result.imageUrl,
      error: result.error,
      balance: result.balance,
    },
    { status: result.status === 'succeeded' ? 201 : 200 },
  );
}, { mutation: true });
