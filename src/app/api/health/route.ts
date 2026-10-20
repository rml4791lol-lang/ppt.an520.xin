// 健康检查：供监控探针/负载均衡探测。无需登录、无副作用。
// 监控脚本（anppt-health-monitor.py）契约：顶层 ok / llm.configured / image.configured / editable.configured。
import { getDb } from '@/lib/server/db';
import { getGenerationConfig } from '@/lib/server/generation/config';
import { getGenDb } from '@/lib/server/generation/db';
import { configuredEditableProviders } from '@/modules/editable-export/server/editable';

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
  let editable = {
    configured: false,
    provider: '',
    providers: [] as string[],
    image2ppt: { configured: false, webhookConfigured: false },
    queue: { active: 0, failedLastHour: 0, succeededLastHour: 0, oldestActiveAgeMs: 0 },
  };
  try {
    const config = getGenerationConfig();
    llmConfigured = Boolean(config.llmApiKey);
    imageConfigured = Boolean(config.imageBaseUrl && config.imageApiKey);
    const providers = configuredEditableProviders(config);
    editable = {
      configured: providers.length > 0,
      provider: config.editableProvider,
      providers,
      image2ppt: {
        configured: Boolean(config.image2pptApiKey),
        webhookConfigured: Boolean(config.image2pptWebhookSecret),
      },
      queue: editable.queue,
    };
    if (db) {
      const now = Date.now();
      const active = getGenDb()
        .prepare(
          `SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM export_jobs
           WHERE kind = 'editable' AND status IN ('pending', 'processing')`,
        )
        .get() as { c?: number; oldest?: number | null } | undefined;
      const failed = getGenDb()
        .prepare(
          `SELECT COUNT(*) AS c FROM export_jobs
           WHERE kind = 'editable' AND status = 'failed' AND updated_at >= ?`,
        )
        .get(now - 3_600_000) as { c?: number } | undefined;
      const succeeded = getGenDb()
        .prepare(
          `SELECT COUNT(*) AS c FROM export_jobs
           WHERE kind = 'editable' AND status = 'succeeded' AND updated_at >= ?`,
        )
        .get(now - 3_600_000) as { c?: number } | undefined;
      editable.queue = {
        active: Number(active?.c) || 0,
        failedLastHour: Number(failed?.c) || 0,
        succeededLastHour: Number(succeeded?.c) || 0,
        oldestActiveAgeMs: active?.oldest ? Math.max(0, now - Number(active.oldest)) : 0,
      };
    }
  } catch {
    // 配置读取失败即视为未配置
  }
  return Response.json({
    ok: db,
    service: 'anppt-v2',
    db,
    llm: { configured: llmConfigured },
    image: { configured: imageConfigured },
    editable,
    ts: Date.now(),
  });
}
