import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { assertFeatureVisible } from '@/lib/server/feature-flags';
import { defineApiRoute } from '@/lib/server/generation/route';
import { generateSinglePage } from '@/lib/server/generation/single-pages';
import { generateReplicatePage } from '@/modules/ppt-replicate/server/facade';
import { cleanString } from '@/lib/server/generation/types';
import { SINGLE_PAGE_INTENT_PARAMS } from '@/lib/single-page-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页生成：{pageId, projectId?, title?, content, stylePackId?, imagePath?, mode?, colorMode?, structure?, requestId?}，10🌟/张 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const { params: body } = readIntentParams(await readJsonBody(request), SINGLE_PAGE_INTENT_PARAMS, 'generatePage');
  const mode = cleanString(body.mode, 20);
  const pageInput = {
    pageId: String(body.pageId ?? ''),
    projectId: body.projectId ? String(body.projectId) : undefined,
    title: body.title ? String(body.title) : undefined,
    content: String(body.content ?? ''),
    stylePackId: body.stylePackId ? String(body.stylePackId) : undefined,
    imagePath: body.imagePath ? String(body.imagePath) : undefined,
    requestId: body.requestId ? String(body.requestId) : undefined,
  };
  if (mode === 'replicate') assertFeatureVisible('ppt_replicate', user);
  // mode=replicate 是美化工作台的分支：实体与提示词归模块，缺省生成仍走平台单页运行时。
  const result = mode === 'replicate'
    ? await generateReplicatePage(user.id, {
        ...pageInput,
        colorMode: body.colorMode ? String(body.colorMode) : undefined,
        structureProvided: Object.prototype.hasOwnProperty.call(body, 'structure'),
        structure: body.structure,
      })
    : await generateSinglePage(user.id, pageInput);
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
