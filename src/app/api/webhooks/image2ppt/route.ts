import { defineRoute } from '@/lib/server/http';
import { handleImage2PptWebhook } from '@/modules/editable-export/server/editable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Image2PPT 完成回调。验签在模块内完成，不依赖登录 Cookie / CSRF。 */
export const POST = defineRoute(async (request) => {
  const rawBody = await request.text();
  const result = await handleImage2PptWebhook(rawBody, request.headers);
  return Response.json(result.body, { status: result.status });
});
