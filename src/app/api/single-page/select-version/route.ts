import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { selectSinglePageVersion } from '@/lib/server/generation/single-pages';
import { singlePageIntentParams } from '@/lib/single-page-intents';
import { readActionParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页版本选择/回退：{pageId, versionId}，仅允许生成成功的版本 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = readActionParams(await readJsonBody(request), (intent) => singlePageIntentParams('selectVersion', intent));
  const page = selectSinglePageVersion(user.id, String(body.pageId ?? ''), String(body.versionId ?? ''));
  return jsonOk({
    pageId: page.pageId,
    projectId: page.projectId,
    status: page.status,
    activeVersionId: page.activeVersionId,
  });
}, { mutation: true });
