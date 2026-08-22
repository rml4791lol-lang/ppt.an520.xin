import { requireAdmin } from '@/lib/server/admin';
import { unwatchAdminUser, watchAdminUser } from '@/lib/server/admin-dashboard';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { jsonOk, readJsonBody } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PUT = defineApiRoute(async (request, ctx) => {
  const { user } = requireAdmin(request);
  const targetUserId = await paramOf(ctx, 'id');
  const body = await readJsonBody(request);
  const snapshot = watchAdminUser({
    adminUserId: user.id,
    targetUserId,
    label: String(body.label ?? ''),
  });
  return jsonOk(snapshot, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}, { mutation: true });

export const DELETE = defineApiRoute(async (request, ctx) => {
  const { user } = requireAdmin(request);
  const targetUserId = await paramOf(ctx, 'id');
  unwatchAdminUser({ adminUserId: user.id, targetUserId });
  return jsonOk({ userId: targetUserId, watched: false }, {
    headers: { 'Cache-Control': 'private, no-store, max-age=0' },
  });
}, { mutation: true });
