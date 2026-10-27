import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { getDeckState } from '@/lib/server/generation/decks';
import { dispatchDeckRequest, parseDeckRequest } from '@/lib/server/generation/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 工作台全量状态（前端 ~2.5s 轮询） */
export const GET = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  return jsonOk(getDeckState(user.id, id));
});

/** 意图 RPC：{intent: {kind, params}}（contract 见 src/lib/deck-intents.ts）。
 * 旧 {action, ...params} 信封仍由 parseDeckRequest 收窄，脚本与灰度客户端不受影响。 */
export const POST = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  const deckRequest = parseDeckRequest(await readJsonBody(request));
  const result = await dispatchDeckRequest(user.id, id, deckRequest);
  return jsonOk({ ...result.state, ...result.extra }, { status: result.status });
}, { mutation: true });
