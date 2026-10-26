#!/usr/bin/env node
// 跨站回退 + 本地计量 + 财务口径冒烟（真实调用上游，小额消耗）：
//   node --env-file=.env.local scripts/smoke-fallback.mjs
// 预期：主站（中转站）若 402/不可达则自动切备份站（DeepSeek 官方），
// upstream_usage_records 落行，/api/admin/finance 同口径汇总。
import { registerTsHooks } from './ts-hooks.mjs';

registerTsHooks();

const { chatCompletion } = await import('../src/lib/server/engine.ts');
const { getFinanceStats } = await import('../src/lib/server/finance-stats.ts');
const { getGenerationConfig } = await import('../src/lib/server/generation/config.ts');

const config = getGenerationConfig();
console.log('[config] 主站:', config.llmBaseUrl, '| 主模型:', config.llmModel, '| 站内回退:', config.llmFallbackModels.join(','));
console.log('[config] 备份站:', config.llmBackupBaseUrl || '(未配置)', '| 备份模型:', config.llmBackupModel || '-');

const startedAt = Date.now();
const text = await chatCompletion([
  { role: 'system', content: '你是测试助手，只输出用户要求的 JSON，不要输出任何其他内容。' },
  { role: 'user', content: '输出 JSON：{"ok":true}' },
], {});
console.log(`[chat] ${Date.now() - startedAt}ms 返回:`, text.slice(0, 120));

const stats = await getFinanceStats();
console.log('[finance] upstreamUsage.total:', JSON.stringify(stats.upstreamUsage.total));
console.log('[finance] upstreamUsage.byProvider:', JSON.stringify(stats.upstreamUsage.byProvider, null, 2));
console.log('[finance] income:', JSON.stringify({ orders: stats.income.paidOrders, yuan: stats.income.totalYuan }));
console.log('[finance] consumption.creditsSpent:', stats.consumption.creditsSpent);

// ---- 跨站回退单测（mock fetch，不烧额度）：主站全灭 → 备份站接管 ----
const mockConfig = {
  ...config,
  llmBaseUrl: 'http://primary.invalid/v1',
  llmApiKey: 'sk-primary',
  llmModel: 'm1',
  llmFallbackModels: ['m2'],
  llmBackupBaseUrl: 'http://backup.invalid/v1',
  llmBackupApiKey: 'sk-backup',
  llmBackupModel: 'm3',
};
const seenUrls = [];
const mockFetch = async (url) => {
  seenUrls.push(String(url));
  if (String(url).includes('backup.invalid')) {
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true,"via":"backup"}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 5 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: { message: 'primary down' } }), { status: 500 });
};
const fallbackText = await chatCompletion(
  [{ role: 'user', content: 'ping' }],
  { config: mockConfig, fetchImpl: mockFetch },
);
const backupUsed = seenUrls.some((u) => u.includes('backup.invalid/v1/chat/completions'));
console.log('[failover] 主站失败次数:', seenUrls.filter((u) => u.includes('primary.invalid')).length,
  '| 备份站被调用:', backupUsed, '| 返回:', fallbackText.slice(0, 60));
if (!backupUsed || !fallbackText.includes('backup')) {
  console.error('[failover] FAIL: 备份站未接管');
  process.exit(1);
}
console.log('[failover] PASS');

// 清理 mock 段落产生的计量行（不污染真实账本）
const { getDb } = await import('../src/lib/server/db.ts');
getDb().prepare(`DELETE FROM upstream_usage_records WHERE model IN ('m1','m2','m3')`).run();
