import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { assertFeatureVisible } from '@/lib/server/feature-flags';
import { defineApiRoute } from '@/lib/server/generation/route';
import { generateSinglePage } from '@/lib/server/generation/single-pages';
import { cleanString } from '@/lib/server/generation/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页生成：{pageId, projectId?, title?, content, stylePackId?, imagePath?, mode?, colorMode?, structure?, requestId?}，10🌟/张 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = await readJsonBody(request);
  const mode = cleanString(body.mode, 20);
  if (mode === 'replicate') assertFeatureVisible('ppt_replicate', user);
  const result = await generateSinglePage(user.id, {
    pageId: String(body.pageId ?? ''),
    projectId: body.projectId ? String(body.projectId) : undefined,
    title: body.title ? String(body.title) : undefined,
    content: String(body.content ?? ''),
    stylePackId: body.stylePackId ? String(body.stylePackId) : undefined,
    imagePath: body.imagePath ? String(body.imagePath) : undefined,
    mode: mode || undefined,
    colorMode: body.colorMode ? String(body.colorMode) : undefined,
    requestId: body.requestId ? String(body.requestId) : undefined,
    structureProvided: Object.prototype.hasOwnProperty.call(body, 'structure'),
    structure: body.structure,
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
