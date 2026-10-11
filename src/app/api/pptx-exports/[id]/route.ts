import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { getExport } from '@/modules/editable-export/server/editable';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  return jsonOk(await getExport(user.id, id));
});
