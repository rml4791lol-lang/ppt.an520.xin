import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { getDb, withTransaction } from './db';
import { ApiError, validationError } from './http';

export type AdminConfigGroup = 'llm' | 'image' | 'editable' | 'capacity';
export type AdminConfigInput = 'text' | 'password' | 'number' | 'url';
export type AdminConfigKey =
  | 'ANPPT_V2_LLM_BASE_URL'
  | 'ANPPT_V2_LLM_API_KEY'
  | 'ANPPT_V2_LLM_MODEL'
  | 'ANPPT_V2_LLM_FALLBACK_MODELS'
  | 'ANPPT_V2_IMAGE_BASE_URL'
  | 'ANPPT_V2_IMAGE_API_KEY'
  | 'ANPPT_V2_IMAGE_MODEL'
  | 'ANPPT_V2_IMAGE_SIZE'
  | 'ANPPT_V2_EDITABLE_PROVIDER'
  | 'ANPPT_V2_CODIA_BASE_URL'
  | 'ANPPT_V2_CODIA_API_KEY'
  | 'ANPPT_V2_IMAGE2PPT_BASE_URL'
  | 'ANPPT_V2_IMAGE2PPT_API_KEY'
  | 'ANPPT_V2_IMAGE2PPT_WEBHOOK_SECRET'
  | 'ANPPT_V2_IMAGE_TIMEOUT_MS'
  | 'ANPPT_V2_GENERATE_CONCURRENCY'
  | 'ANPPT_V2_IMAGE_GLOBAL_CONCURRENCY'
  | 'ANPPT_V2_IMAGE_STARTS_PER_MINUTE'
  | 'ANPPT_V2_IMAGE_MAX_RETRIES';

export interface AdminConfigDefinition {
  key: AdminConfigKey;
  group: AdminConfigGroup;
  label: string;
  description: string;
  input: AdminConfigInput;
  secret: boolean;
  defaultValue: string;
  min?: number;
  max?: number;
}

const DEFINITIONS: readonly AdminConfigDefinition[] = [
  {
    key: 'ANPPT_V2_LLM_BASE_URL', group: 'llm', label: 'LLM API 地址', input: 'url', secret: false,
    defaultValue: 'https://api.deepseek.com/v1', description: 'OpenAI 兼容接口根地址，检查时只请求 /models。',
  },
  {
    key: 'ANPPT_V2_LLM_API_KEY', group: 'llm', label: 'LLM API 密钥', input: 'password', secret: true,
    defaultValue: '', description: '只允许替换，不会向浏览器返回现有明文。',
  },
  {
    key: 'ANPPT_V2_LLM_MODEL', group: 'llm', label: '主模型', input: 'text', secret: false,
    defaultValue: 'deepseek-v4-flash', description: '大纲与内容梳理优先使用的模型。不用 PRO。',
  },
  {
    key: 'ANPPT_V2_LLM_FALLBACK_MODELS', group: 'llm', label: '回退模型链', input: 'text', secret: false,
    defaultValue: '', description: '按顺序用英文逗号分隔，最多 3 个。空=不回退。',
  },
  {
    key: 'ANPPT_V2_IMAGE_BASE_URL', group: 'image', label: '生图 API 地址', input: 'url', secret: false,
    defaultValue: '', description: 'OpenAI 兼容图片接口根地址。',
  },
  {
    key: 'ANPPT_V2_IMAGE_API_KEY', group: 'image', label: '生图 API 密钥', input: 'password', secret: true,
    defaultValue: '', description: '只允许替换，不会向浏览器返回现有明文。',
  },
  {
    key: 'ANPPT_V2_IMAGE_MODEL', group: 'image', label: '生图模型', input: 'text', secret: false,
    defaultValue: 'gpt-image-2', description: '后续新请求使用；不会改变已在途任务。',
  },
  {
    key: 'ANPPT_V2_IMAGE_SIZE', group: 'image', label: '图片尺寸', input: 'text', secret: false,
    defaultValue: '1536x864', description: '宽×高，例如 1536x864。',
  },
  {
    key: 'ANPPT_V2_EDITABLE_PROVIDER', group: 'editable', label: '可编辑转换主通道', input: 'text', secret: false,
    defaultValue: 'codia', description: 'codia / image2ppt / auto；auto 优先 image2ppt，失败回退 Codia。',
  },
  {
    key: 'ANPPT_V2_CODIA_BASE_URL', group: 'editable', label: 'Codia API 地址', input: 'url', secret: false,
    defaultValue: 'https://openapi.codia.ai', description: '可编辑转换服务地址。',
  },
  {
    key: 'ANPPT_V2_CODIA_API_KEY', group: 'editable', label: 'Codia API 密钥', input: 'password', secret: true,
    defaultValue: '', description: '检查时调用官方积分查询接口，不创建转换任务。',
  },
  {
    key: 'ANPPT_V2_IMAGE2PPT_BASE_URL', group: 'editable', label: 'Image2PPT API 地址', input: 'url', secret: false,
    defaultValue: 'https://image2ppt.com', description: 'Image2PPT 开放 API 根地址。',
  },
  {
    key: 'ANPPT_V2_IMAGE2PPT_API_KEY', group: 'editable', label: 'Image2PPT API 密钥', input: 'password', secret: true,
    defaultValue: '', description: '检查时只读账户额度，不创建转换任务。',
  },
  {
    key: 'ANPPT_V2_IMAGE2PPT_WEBHOOK_SECRET', group: 'editable', label: 'Image2PPT Webhook 密钥', input: 'password', secret: true,
    defaultValue: '', description: 'Standard Webhooks whsec_ 密钥，用于校验完成回调。',
  },
  {
    key: 'ANPPT_V2_IMAGE_TIMEOUT_MS', group: 'capacity', label: '单次生图超时（毫秒）', input: 'number', secret: false,
    defaultValue: '480000', min: 60_000, max: 1_200_000, description: '建议至少 300000；修改只影响后续请求。',
  },
  {
    key: 'ANPPT_V2_GENERATE_CONCURRENCY', group: 'capacity', label: '单套 PPT 并发', input: 'number', secret: false,
    defaultValue: '6', min: 1, max: 12, description: '同一套 PPT 同时生成的页面数。',
  },
  {
    key: 'ANPPT_V2_IMAGE_GLOBAL_CONCURRENCY', group: 'capacity', label: '全站生图并发', input: 'number', secret: false,
    defaultValue: '20', min: 1, max: 40, description: '全站同时发往上游的最大请求数。',
  },
  {
    key: 'ANPPT_V2_IMAGE_STARTS_PER_MINUTE', group: 'capacity', label: '每分钟启动上限', input: 'number', secret: false,
    defaultValue: '24', min: 1, max: 120, description: '滚动一分钟内最多启动的生图请求数。',
  },
  {
    key: 'ANPPT_V2_IMAGE_MAX_RETRIES', group: 'capacity', label: '瞬态错误恢复次数', input: 'number', secret: false,
    defaultValue: '2', min: 0, max: 3, description: '仅网络、429 与 5xx；业务错误不会盲目重试。',
  },
];

export interface AdminConfigFieldView {
  key: AdminConfigKey;
  group: AdminConfigGroup;
  label: string;
  description: string;
  input: AdminConfigInput;
  secret: boolean;
  value: string | null;
  configured: boolean;
  source: 'runtime' | 'environment' | 'default' | 'missing';
  fingerprint: string | null;
  runtimeOverride: boolean;
  min?: number;
  max?: number;
}

interface RuntimeRow {
  key: string;
  encrypted_value: string;
}

interface RuntimeCache {
  expiresAt: number;
  values: Partial<Record<AdminConfigKey, string>>;
}

const CONFIG_KEY_ENV = 'ANPPT_V2_ADMIN_CONFIG_KEY';
const CACHE_TTL_MS = 30_000;
const allowedKeys = new Set<string>(DEFINITIONS.map((item) => item.key));
const definitionByKey = new Map<string, AdminConfigDefinition>(DEFINITIONS.map((item) => [item.key, item]));
const globalRef = globalThis as typeof globalThis & { __anpptAdminConfigCache?: RuntimeCache | null };

function trim(value: unknown): string {
  return String(value ?? '').trim();
}

function masterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = trim(env[CONFIG_KEY_ENV]);
  if (raw.length < 32) return null;
  return createHash('sha256').update(raw).digest();
}

export function isAdminConfigStorageReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(masterKey(env));
}

function encryptValue(keyName: string, value: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = masterKey(env);
  if (!key) {
    throw new ApiError(
      'ADMIN_CONFIG_STORAGE_UNAVAILABLE',
      `${CONFIG_KEY_ENV} 未配置，暂时不能保存运行时密钥`,
      503,
      false,
    );
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(keyName));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptValue(keyName: string, encrypted: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = masterKey(env);
  if (!key) throw new Error('admin config master key is unavailable');
  const [version, ivRaw, tagRaw, ciphertextRaw] = encrypted.split(':');
  if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw) throw new Error('invalid encrypted config payload');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAAD(Buffer.from(keyName));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = host.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function normalizeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validationError('请输入完整、有效的 API 地址');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw validationError('API 地址不能包含账号、密码、查询参数或片段');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateOrLoopbackHostname(url.hostname))) {
    throw validationError('公网 API 必须使用 HTTPS；HTTP 仅允许本机或内网地址');
  }
  return url.toString().replace(/\/+$/, '');
}

function normalizeModel(value: string): string {
  const model = trim(value);
  if (!model || model.length > 160 || !/^[A-Za-z0-9._:/+-]+$/.test(model)) {
    throw validationError('模型名称格式不正确');
  }
  return model;
}

export function normalizeAdminConfigValue(key: AdminConfigKey, rawValue: unknown): string {
  const definition = definitionByKey.get(key);
  if (!definition) throw validationError('不支持的配置项');
  const value = trim(rawValue);
  if (definition.secret) {
    if (value.length < 6 || value.length > 4096 || /[\r\n\0]/.test(value)) {
      throw validationError(`${definition.label}格式不正确`);
    }
    return value;
  }
  if (definition.input === 'url') return normalizeUrl(value);
  if (definition.input === 'number') {
    const numberValue = Number(value);
    if (!Number.isSafeInteger(numberValue)
      || (definition.min != null && numberValue < definition.min)
      || (definition.max != null && numberValue > definition.max)) {
      throw validationError(`${definition.label}应为 ${definition.min ?? 0}–${definition.max ?? '允许范围'} 的整数`);
    }
    return String(numberValue);
  }
  if (key === 'ANPPT_V2_LLM_FALLBACK_MODELS') {
    if (!value) return '';
    const models = value.split(',').map((item) => normalizeModel(item));
    if (models.length > 3) throw validationError('回退模型最多配置 3 个');
    return [...new Set(models)].join(',');
  }
  if (key === 'ANPPT_V2_IMAGE_SIZE') {
    const match = value.match(/^(\d{3,4})x(\d{3,4})$/);
    if (!match || Number(match[1]) < 512 || Number(match[1]) > 4096 || Number(match[2]) < 512 || Number(match[2]) > 4096) {
      throw validationError('图片尺寸应为 512–4096 范围内的“宽x高”');
    }
    return value;
  }
  if (key === 'ANPPT_V2_EDITABLE_PROVIDER') {
    const provider = value.toLowerCase();
    if (!['codia', 'image2ppt', 'auto'].includes(provider)) {
      throw validationError('可编辑转换主通道只能是 codia、image2ppt 或 auto');
    }
    return provider;
  }
  if (key === 'ANPPT_V2_LLM_MODEL' || key === 'ANPPT_V2_IMAGE_MODEL') return normalizeModel(value);
  if (!value || value.length > 500 || /[\r\n\0]/.test(value)) throw validationError(`${definition.label}格式不正确`);
  return value;
}

function loadRuntimeValues(env: NodeJS.ProcessEnv = process.env): Partial<Record<AdminConfigKey, string>> {
  if (!masterKey(env)) return {};
  const now = Date.now();
  const cached = globalRef.__anpptAdminConfigCache;
  if (cached && cached.expiresAt > now) return { ...cached.values };
  const rows = getDb().prepare('SELECT key, encrypted_value FROM admin_runtime_config').all() as unknown as RuntimeRow[];
  const values: Partial<Record<AdminConfigKey, string>> = {};
  for (const row of rows) {
    if (!allowedKeys.has(row.key)) continue;
    try {
      values[row.key as AdminConfigKey] = decryptValue(row.key, row.encrypted_value, env);
    } catch (error) {
      console.error(`[anppt-v2][admin-config] 配置 ${row.key} 解密失败：`, error instanceof Error ? error.message : error);
    }
  }
  globalRef.__anpptAdminConfigCache = { expiresAt: now + CACHE_TTL_MS, values };
  return { ...values };
}

export function invalidateAdminConfigCache(): void {
  globalRef.__anpptAdminConfigCache = null;
}

/** 仅用于测试隔离。 */
export function resetAdminConfigCacheForTests(): void {
  invalidateAdminConfigCache();
}

export function getRuntimeConfigOverrides(): Partial<Record<AdminConfigKey, string>> {
  return loadRuntimeValues();
}

export function getEffectiveGenerationEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...baseEnv, ...loadRuntimeValues(baseEnv) };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

export function listAdminConfigFields(env: NodeJS.ProcessEnv = process.env): {
  storageReady: boolean;
  fields: AdminConfigFieldView[];
} {
  const runtime = loadRuntimeValues(env);
  const fields = DEFINITIONS.map((definition): AdminConfigFieldView => {
    const runtimeValue = runtime[definition.key];
    const envValue = trim(env[definition.key]);
    const effective = runtimeValue ?? (envValue || definition.defaultValue);
    const source = runtimeValue != null
      ? 'runtime'
      : envValue
        ? 'environment'
        : definition.defaultValue
          ? 'default'
          : 'missing';
    return {
      key: definition.key,
      group: definition.group,
      label: definition.label,
      description: definition.description,
      input: definition.input,
      secret: definition.secret,
      value: definition.secret ? null : effective,
      configured: Boolean(effective),
      source,
      fingerprint: definition.secret && effective ? fingerprint(effective) : null,
      runtimeOverride: runtimeValue != null,
      ...(definition.min == null ? {} : { min: definition.min }),
      ...(definition.max == null ? {} : { max: definition.max }),
    };
  });
  return { storageReady: isAdminConfigStorageReady(env), fields };
}

export function updateAdminRuntimeConfig(input: {
  adminUserId: string;
  values?: Record<string, unknown>;
  clearKeys?: unknown[];
}): { changedKeys: AdminConfigKey[]; clearedKeys: AdminConfigKey[] } {
  if (!isAdminConfigStorageReady()) {
    throw new ApiError('ADMIN_CONFIG_STORAGE_UNAVAILABLE', '管理员配置密钥尚未就绪', 503, false);
  }
  const rawValues = input.values && typeof input.values === 'object' ? input.values : {};
  const changed = new Map<AdminConfigKey, string>();
  for (const [rawKey, rawValue] of Object.entries(rawValues)) {
    if (!allowedKeys.has(rawKey)) throw validationError(`不支持的配置项：${rawKey}`);
    changed.set(rawKey as AdminConfigKey, normalizeAdminConfigValue(rawKey as AdminConfigKey, rawValue));
  }
  const cleared = new Set<AdminConfigKey>();
  for (const rawKey of input.clearKeys ?? []) {
    const key = trim(rawKey);
    if (!allowedKeys.has(key)) throw validationError(`不支持的配置项：${key}`);
    cleared.add(key as AdminConfigKey);
    changed.delete(key as AdminConfigKey);
  }
  if (changed.size === 0 && cleared.size === 0) throw validationError('没有需要保存的配置变化');

  const db = getDb();
  const now = Date.now();
  withTransaction(db, () => {
    const upsert = db.prepare(`
      INSERT INTO admin_runtime_config (key, encrypted_value, updated_by, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,
        updated_by=excluded.updated_by, updated_at=excluded.updated_at
    `);
    for (const [key, value] of changed) {
      upsert.run(key, encryptValue(key, value), input.adminUserId, now);
    }
    const remove = db.prepare('DELETE FROM admin_runtime_config WHERE key = ?');
    for (const key of cleared) remove.run(key);
  });
  invalidateAdminConfigCache();
  return { changedKeys: [...changed.keys()], clearedKeys: [...cleared] };
}

export function mergeAdminConfigDraft(
  values: Record<string, unknown> | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = getEffectiveGenerationEnv(baseEnv);
  for (const [rawKey, rawValue] of Object.entries(values ?? {})) {
    if (!allowedKeys.has(rawKey)) throw validationError(`不支持的配置项：${rawKey}`);
    if (trim(rawValue) === '') continue;
    merged[rawKey] = normalizeAdminConfigValue(rawKey as AdminConfigKey, rawValue);
  }
  return merged;
}

export function adminConfigDefinitions(): readonly AdminConfigDefinition[] {
  return DEFINITIONS;
}
