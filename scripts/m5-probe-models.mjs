// M5 排障：探测网关上各 chat 模型渠道健康度（不打印密钥）。
// 用法：node --env-file=.env.local scripts/m5-probe-models.mjs [model1,model2,...]
import { createHash } from 'node:crypto';

const base = (process.env.ANPPT_V2_LLM_BASE_URL || 'http://127.0.0.1:6800/v1').replace(/\/+$/, '');
const key = process.env.ANPPT_V2_LLM_API_KEY || '';
if (!key) { console.log('no ANPPT_V2_LLM_API_KEY'); process.exit(1); }
console.log('base:', base, '| key fp:', createHash('sha256').update(key).digest('hex').slice(0, 10));

const candidates = process.argv[2]
  ? process.argv[2].split(',')
  : ['deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3-flash', 'claude-haiku-4-5', 'gpt-5.5-openai-compact'];

for (const model of candidates) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '回复两个字：正常' }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (res.ok) {
      let content = '';
      try { content = JSON.parse(text)?.choices?.[0]?.message?.content ?? ''; } catch { /* ignore */ }
      console.log(`OK   ${model}  ${ms}ms  → ${String(content).slice(0, 40).replace(/\n/g, ' ')}`);
    } else {
      let msg = text.slice(0, 120).replace(/\n/g, ' ');
      try { msg = JSON.parse(text)?.error?.message ?? msg; } catch { /* ignore */ }
      console.log(`FAIL ${model}  HTTP ${res.status}  ${ms}ms  ${String(msg).slice(0, 120)}`);
    }
  } catch (e) {
    console.log(`ERR  ${model}  ${Date.now() - t0}ms  ${e instanceof Error ? e.message : e}`);
  }
}
