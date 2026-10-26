import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { exportDeckImagePptx } from '@/lib/server/exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 图片版 PPTX 导出（免费）：16:9 逐页嵌图 → data/exports/，返回下载 URL */
export const POST = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  const result = await exportDeckImagePptx(user.id, id);
  return jsonOk(result, { status: 201 });
}, { mutation: true });
