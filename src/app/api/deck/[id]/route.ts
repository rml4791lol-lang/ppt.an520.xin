import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { getDeckState } from '@/lib/server/generation/decks';
import { dispatchDeckAction } from '@/lib/server/generation/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 工作台全量状态（前端 ~2.5s 轮询） */
export const GET = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  return jsonOk(getDeckState(user.id, id));
});

/** action RPC：{action: outline | add-slide | delete-slide | reorder-slides | split-slide |
 * structure | structure-slide | confirm-structure | unlock-structure | style |
 * generate | generate-slide | refine-slide | retry-failed, ...} */
export const POST = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  const body = await readJsonBody(request);
  const result = await dispatchDeckAction(user.id, id, body);
  return jsonOk({ ...result.state, ...result.extra }, { status: result.status });
}, { mutation: true });
