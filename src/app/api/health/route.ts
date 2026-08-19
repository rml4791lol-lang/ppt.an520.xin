// 健康检查：供监控探针/负载均衡探测。无需登录、无副作用。
// 监控脚本（anppt-health-monitor.py）契约：顶层 ok / llm.configured。
import { getDb } from '@/lib/server/db';
import { getGenerationConfig } from '@/lib/server/generation/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  let db = false;
  try {
    getDb().prepare('SELECT 1').get();
    db = true;
  } catch {
    db = false;
  }
  let llmConfigured = false;
  let imageConfigured = false;
  try {
    const config = getGenerationConfig();
    llmConfigured = Boolean(config.llmApiKey);
    imageConfigured = Boolean(config.imageBaseUrl && config.imageApiKey);
  } catch {
    // 配置读取失败即视为未配置
  }
  return Response.json({
    ok: db,
    service: 'anppt-v2',
    db,
    llm: { configured: llmConfigured },
    image: { configured: imageConfigured },
    ts: Date.now(),
  });
}
