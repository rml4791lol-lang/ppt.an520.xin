// 健康检查：供监控探针/负载均衡探测。无需登录、无副作用。
import { defineRoute, jsonOk } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async () => {
  let db = false;
  try {
    getDb().prepare('SELECT 1').get();
    db = true;
  } catch {
    db = false;
  }
  return jsonOk({ service: 'anppt-v2', db, ts: Date.now() });
});
