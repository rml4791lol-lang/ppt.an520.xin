import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { generateSinglePage } from '@/lib/server/generation/single-pages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页生成：{pageId, projectId?, title?, content, stylePackId?, requestId?}，10🌟/张 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = await readJsonBody(request);
  const result = await generateSinglePage(user.id, {
    pageId: String(body.pageId ?? ''),
    projectId: body.projectId ? String(body.projectId) : undefined,
    title: body.title ? String(body.title) : undefined,
    content: String(body.content ?? ''),
    stylePackId: body.stylePackId ? String(body.stylePackId) : undefined,
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
