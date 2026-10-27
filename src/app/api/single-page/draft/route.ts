import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { saveReplicateDraft } from '@/modules/ppt-replicate/server/facade';
import { assertFeatureVisible } from '@/lib/server/feature-flags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PPT 美化草稿：保存参考稿路径/文案，不生成、不扣星；刷新后可恢复。 */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  assertFeatureVisible('ppt_replicate', user);
  const body = await readJsonBody(request);
  const result = saveReplicateDraft(user.id, {
    projectId: body.projectId ? String(body.projectId) : undefined,
    title: body.title ? String(body.title) : undefined,
    pages: Array.isArray(body.pages) ? body.pages : [],
  });
  return jsonOk(result, { status: 201 });
}, { mutation: true });
