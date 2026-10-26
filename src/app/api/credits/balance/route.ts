import { defineRoute, jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { getBalance } from '@/lib/server/credits';
import { reconcilePptToBase } from '@/modules/ppt-to-base/server/base-image';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  const { user } = requireUser(request);
  // 懒恢复读点（站点头部每次加载都查余额）：补退被崩溃/重启打断的底座生成
  reconcilePptToBase(user.id);
  return jsonOk({ balance: getBalance(user.id) });
});
