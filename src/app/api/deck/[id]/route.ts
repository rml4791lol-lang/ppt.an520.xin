import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { getDeckState } from '@/lib/server/generation/decks';
import { dispatchDeckIntent } from '@/lib/server/generation/actions';
import { DECK_INTENT_PARAMS } from '@/lib/deck-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 工作台全量状态（前端 ~2.5s 轮询） */
export const GET = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  return jsonOk(getDeckState(user.id, id));
});

/** 意图 RPC：{intent:{kind,params}}（contract 见 src/lib/deck-intents.ts，前置见 src/lib/deck-gates.ts）。 */
export const POST = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  const intent = readIntentParams(await readJsonBody(request), DECK_INTENT_PARAMS);
  const result = await dispatchDeckIntent(user.id, id, intent);
  return jsonOk({ ...result.state, ...result.extra }, { status: result.status });
}, { mutation: true });
