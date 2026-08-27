// M5 排障：列出 LLM 网关可用模型名（不打印任何密钥，只输出指纹）。
// 用法：node --env-file=.env.local scripts/m5-gateway-models.mjs
import { createHash, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.join(process.cwd(), 'data', 'anppt-v2.db');

const trim = (v) => String(v ?? '').trim();
function masterKey() {
  const raw = trim(process.env.ANPPT_V2_ADMIN_CONFIG_KEY);
  if (raw.length < 32) return null;
  return createHash('sha256').update(raw).digest();
}
function decrypt(keyName, enc) {
  const key = masterKey();
  if (!key) return null;
  const [v, iv, tag, data] = String(enc).split(':');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(keyName));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

const overrides = {};
let dbOk = true;
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare('SELECT key, encrypted_value FROM admin_runtime_config').all();
  for (const r of rows) {
    try { overrides[r.key] = decrypt(r.key, r.encrypted_value); } catch { overrides[r.key] = null; }
  }
  db.close();
} catch (e) {
  dbOk = false;
  console.log('db read failed:', e.message);
}

const eff = (k, dflt = '') => {
  const o = overrides[k];
  if (o != null && o !== '') return { value: o, source: 'runtime' };
  const e = trim(process.env[k]);
  if (e) return { value: e, source: 'env' };
  return { value: dflt, source: 'default' };
};

const base = eff('ANPPT_V2_LLM_BASE_URL', 'http://127.0.0.1:6800/v1');
const key = eff('ANPPT_V2_LLM_API_KEY');
const model = eff('ANPPT_V2_LLM_MODEL', 'gemini-3.1-flash-lite');
const fallbacks = eff('ANPPT_V2_LLM_FALLBACK_MODELS', 'gpt-5.6-luna,deepseek-v4-flash');
const imgBase = eff('ANPPT_V2_IMAGE_BASE_URL');
const imgKey = eff('ANPPT_V2_IMAGE_API_KEY');
const imgModel = eff('ANPPT_V2_IMAGE_MODEL', 'gpt-image-2');

console.log('master key present:', masterKey() ? 'yes' : 'NO');
console.log('db overrides:', dbOk ? (Object.keys(overrides).join(', ') || '(none)') : '(db unreadable)');
console.log('--- llm ---');
console.log('base url :', base.value, `(${base.source})`);
console.log('model    :', model.value, `(${model.source})`);
console.log('fallbacks:', fallbacks.value, `(${fallbacks.source})`);
console.log('api key  :', key.value ? `set fp=${createHash('sha256').update(key.value).digest('hex').slice(0, 10)} (${key.source})` : 'MISSING');
console.log('--- image ---');
console.log('base url :', imgBase.value || '(empty → 走 llm base?)', `(${imgBase.source})`);
console.log('model    :', imgModel.value, `(${imgModel.source})`);
console.log('api key  :', imgKey.value ? `set fp=${createHash('sha256').update(imgKey.value).digest('hex').slice(0, 10)} (${imgKey.source})` : 'MISSING');

if (!key.value) {
  console.log('\n没有可用 LLM key，无法列模型。');
  process.exit(1);
}

const url = base.value.replace(/\/+$/, '') + '/models';
const res = await fetch(url, { headers: { Authorization: `Bearer ${key.value}` } });
console.log('\ngateway GET /models →', res.status);
const text = await res.text();
let ids = [];
try {
  const json = JSON.parse(text);
  ids = (json.data || []).map((m) => m.id).sort();
} catch {
  console.log('non-json response:', text.slice(0, 300));
  process.exit(1);
}
console.log('models count:', ids.length);
const glm = ids.filter((id) => /glm|zhipu|chatglm/i.test(id));
console.log('glm-ish:', glm.length ? glm.join(', ') : '(none)');
console.log('--- all ids ---');
for (const id of ids) console.log(' -', id);
