// gpt-image-2 生图上游客户端。站点池（主站 + 两站跨站灾备）按单价升序尝试、失败逐站回退；
// 同价同模型的站之间按请求轮换起点，站内多把 key 逐请求轮转，401/402/403 与余额/配额耗尽（上游可能用 400 表达，
// 2026-10-31 事故）的死 key 冷却后跳过——整站 key 都在冷却即站点熔断，请求不再打过去；
// OpenAI 兼容站走 /images/generations + /images/edits；atlascloud 走异步预测 API
// （/model/generateImage + /model/prediction）。
// 所有真实请求经过全局并发/启动速率调度，并只对瞬态错误做有限后台恢复。
import { getGenerationConfig, type GenerationConfig } from './config';
import { cleanString } from './types';
import { recordUpstreamUsage, type UsageProvider } from '../usage-meter';
import { logProblem } from '../problem-log';

export interface ImageDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
  /** 注入时钟：死 key 冷却窗口判定（测试用，生产走 Date.now） */
  now?: () => number;
}

export class ImageUpstreamError extends Error {
  status: number;
  /** 上游错误体摘要（≤300 字符）：余额类判定与问题日志共用，不扩大保留原始响应体 */
  detail: string;
  constructor(message: string, status = 502, detail = '') {
    super(message);
    this.name = 'ImageUpstreamError';
    this.status = status;
    this.detail = detail;
  }
}

/** 日志与健康接口只写 host：完整 baseUrl 可能带路径与凭据 */
function imageHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

// 余额/配额类按文本判定、不按状态码：同一上游会用 400（2026-10-31）/402/403/429 表达欠费。
// 只匹配短语级模式，避免把普通 400（bad request / invalid image）误判成可切站。
const BALANCE_EXHAUSTED_RE = new RegExp([
  'insufficient[_ ]?(?:balance|funds|quota|credits?)',
  'quota[_ ]?exceeded',
  'exceeded[_ ]+(?:your )?quota',
  'billing[_ ]?(?:hard[_ ]?limit|quota|limit|issue|problem)',
  '\\bcredits?\\b',
  '余额不足',
  '余额不够',
  '余额耗尽',
  '余额已用尽',
  '额度不足',
  '额度耗尽',
  '额度已用尽',
  '欠费',
].join('|'), 'i');

function imageErrorText(error: unknown): string {
  if (error instanceof ImageUpstreamError) return `${error.message}\n${error.detail}`;
  return error instanceof Error ? error.message : String(error || '');
}

/** 上游余额/配额耗尽：站点级故障（欠费换 key 也活不了），与「请求本身非法」的 400 区分 */
export function isBalanceExhausted(error: unknown): boolean {
  if (error instanceof ImageUpstreamError && error.status === 402) return true;
  return BALANCE_EXHAUSTED_RE.test(imageErrorText(error));
}

interface ScheduledTask<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  maxConcurrent: number;
  startsPerMinute: number;
  /** 多用户公平调度：同一用户在途/启动过快时让出队列 */
  userKey: string;
  maxPerUser: number;
  userStartsPerMinute: number;
}

interface ImageSchedulerState {
  active: number;
  activeByUser: Map<string, number>;
  starts: number[];
  userStarts: Map<string, number[]>;
  queue: ScheduledTask<unknown>[];
  timer: ReturnType<typeof setTimeout> | null;
}

const schedulerGlobal = globalThis as typeof globalThis & {
  __anpptImageScheduler?: ImageSchedulerState;
};
const scheduler: ImageSchedulerState = schedulerGlobal.__anpptImageScheduler ?? {
  active: 0,
  activeByUser: new Map(),
  starts: [],
  userStarts: new Map(),
  queue: [],
  timer: null,
};
schedulerGlobal.__anpptImageScheduler = scheduler;

function pumpScheduler(): void {
  if (scheduler.timer) {
    clearTimeout(scheduler.timer);
    scheduler.timer = null;
  }
  if (scheduler.queue.length === 0) return;

  const now = Date.now();
  scheduler.starts = scheduler.starts.filter((timestamp) => now - timestamp < 60_000);
  for (const [key, timestamps] of scheduler.userStarts) {
    const kept = timestamps.filter((timestamp) => now - timestamp < 60_000);
    if (kept.length > 0) scheduler.userStarts.set(key, kept);
    else scheduler.userStarts.delete(key);
  }

  // 不能只看队首：队首用户达到个人并发/速率上限时，后面的其他用户仍应继续。
  let nextIndex = -1;
  for (let index = 0; index < scheduler.queue.length; index += 1) {
    const task = scheduler.queue[index];
    if (scheduler.active >= task.maxConcurrent) break;
    if (scheduler.starts.length >= task.startsPerMinute) break;
    if ((scheduler.activeByUser.get(task.userKey) ?? 0) >= task.maxPerUser) continue;
    const userStarts = scheduler.userStarts.get(task.userKey) ?? [];
    if (userStarts.length >= task.userStartsPerMinute) continue;
    nextIndex = index;
    break;
  }

  if (nextIndex < 0) {
    const head = scheduler.queue[0];
    if (scheduler.active >= head.maxConcurrent) return;
    if (scheduler.starts.length >= head.startsPerMinute) {
      const waitMs = Math.max(10, 60_000 - (now - scheduler.starts[0]) + 5);
      scheduler.timer = setTimeout(pumpScheduler, waitMs);
      return;
    }
    // 只被“个人每分钟启动数”挡住时，按最早释放的用户窗口唤醒；
    // 被个人在途上限挡住则等任务完成后的 finally 唤醒即可。
    const waits: number[] = [];
    for (const task of scheduler.queue) {
      const userStarts = scheduler.userStarts.get(task.userKey) ?? [];
      if (userStarts.length >= task.userStartsPerMinute) {
        waits.push(60_000 - (now - userStarts[0]) + 5);
      }
    }
    if (waits.length > 0) {
      scheduler.timer = setTimeout(pumpScheduler, Math.max(10, Math.min(...waits)));
    }
    return;
  }

  const next = scheduler.queue.splice(nextIndex, 1)[0];
  scheduler.active += 1;
  scheduler.activeByUser.set(next.userKey, (scheduler.activeByUser.get(next.userKey) ?? 0) + 1);
  scheduler.starts.push(now);
  const userStarts = scheduler.userStarts.get(next.userKey) ?? [];
  userStarts.push(now);
  scheduler.userStarts.set(next.userKey, userStarts);

  next.run().then(next.resolve, next.reject).finally(() => {
    scheduler.active -= 1;
    const left = (scheduler.activeByUser.get(next.userKey) ?? 1) - 1;
    if (left > 0) scheduler.activeByUser.set(next.userKey, left);
    else scheduler.activeByUser.delete(next.userKey);
    pumpScheduler();
  });
  queueMicrotask(pumpScheduler);
}

function scheduleImageRequest<T>(config: GenerationConfig, userKey: string, run: () => Promise<T>): Promise<T> {
  const maxConcurrent = Math.max(1, config.imageGlobalConcurrency || 20);
  const startsPerMinute = Math.max(1, config.imageStartsPerMinute || 24);
  // 匿名调用（测试/内部探针）没有用户身份，不套个人配额，仍受全局并发与速率约束。
  const anonymous = userKey === 'anonymous';
  return new Promise<T>((resolve, reject) => {
    scheduler.queue.push({
      run,
      resolve: resolve as (value: unknown) => void,
      reject,
      maxConcurrent,
      startsPerMinute,
      userKey,
      maxPerUser: anonymous ? maxConcurrent : Math.max(1, config.imagePerUserConcurrency || 6),
      userStartsPerMinute: anonymous
        ? startsPerMinute
        : Math.max(1, config.imageStartsPerUserPerMinute || 16),
    });
    pumpScheduler();
  });
}

/** 仅测试使用，生产代码不要调用。 */
export function resetImageSchedulerForTests(): void {
  if (scheduler.timer) clearTimeout(scheduler.timer);
  scheduler.active = 0;
  scheduler.activeByUser.clear();
  scheduler.starts = [];
  scheduler.userStarts.clear();
  scheduler.queue = [];
  scheduler.timer = null;
}

/** 上游/配置错误 → 对外口径 */
export function toPublicImageError(error: unknown): { code: string; message: string; status: number } {
  const message = error instanceof Error ? error.message : String(error || '');
  const status = error instanceof ImageUpstreamError ? error.status : 0;
  if (/未配置/.test(message)) {
    return { code: 'IMAGE_NOT_CONFIGURED', message: '生图服务尚未配置，请联系管理员', status: 503 };
  }
  // 余额/配额耗尽排在 400/413 之前：欠费被上游用 400 表达时不能再落成「内容太长」
  if (isBalanceExhausted(error)) {
    return { code: 'IMAGE_QUOTA_EXHAUSTED', message: '生图服务额度暂时不可用，请稍后重试，本次不扣星', status: 503 };
  }
  if (status === 401 || status === 403 || (status === 0 && /401|403/.test(message))) {
    return { code: 'IMAGE_UPSTREAM_UNAVAILABLE', message: '图片服务暂时不可用，星星已退回', status: 502 };
  }
  if (status === 400 || status === 413 || (status === 0 && /400|413/.test(message))) {
    return { code: 'IMAGE_REQUEST_INVALID', message: '本页素材或文字内容可能过长，请简化后再生成', status: 400 };
  }
  if (status === 429 || (status === 0 && /429/.test(message))) {
    return { code: 'IMAGE_RATE_LIMITED', message: '服务器刚刚开了个小差，星星已退回；稍后可继续', status: 429 };
  }
  if (/abort|timeout|超时/i.test(message)) {
    return { code: 'IMAGE_TIMEOUT', message: '图片生成等待超时，星星已退回；稍后可继续', status: 504 };
  }
  return { code: 'IMAGE_GENERATION_FAILED', message: '服务器刚刚开了个小差，星星已退回；稍后可继续', status: 502 };
}

interface ImageResponsePayload {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

/** 问题日志与切站日志共用的站点身份：site + host + 本次实际使用的模型名 */
interface ImageStationLog {
  site: ImageEndpoint['site'];
  host: string;
  model: string;
}

function imageStationLog(endpoint: ImageEndpoint, action: '生图' | '改图'): ImageStationLog {
  return {
    site: endpoint.site,
    host: imageHost(endpoint.baseUrl),
    model: action === '改图' ? endpoint.editModel : endpoint.model,
  };
}

async function parseImageResponse(
  response: Response,
  deps: ImageDeps,
  station: ImageStationLog,
  signal?: AbortSignal,
): Promise<Buffer> {
  const text = await response.text();
  let payload: ImageResponsePayload = {};
  try {
    payload = text ? (JSON.parse(text) as ImageResponsePayload) : {};
  } catch {
    throw new ImageUpstreamError(`HTTP ${response.status}: 上游返回非 JSON`, response.status || 502);
  }
  if (!response.ok) {
    const error = new ImageUpstreamError(
      `HTTP ${response.status}: ${cleanString(payload?.error?.message, 300) || 'upstream error'}`,
      response.status,
      cleanString(text, 300),
    );
    logProblem({
      category: 'image-upstream',
      level: 'error',
      message: `生图上游 HTTP ${response.status}`,
      // 结构化 detail（落盘是 JSON 字符串）：监控按 host 点名站点，按 balance 走余额类告警
      detail: {
        ...station,
        status: response.status,
        balance: isBalanceExhausted(error),
        upstream: cleanString(text, 500),
      },
    });
    throw error;
  }
  const item = payload.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const imageResponse = await fetchImpl(item.url, { signal });
    if (!imageResponse.ok) throw new ImageUpstreamError(`HTTP ${imageResponse.status}: 图片下载失败`, imageResponse.status);
    return Buffer.from(await imageResponse.arrayBuffer());
  }
  throw new ImageUpstreamError('上游未返回图片数据', 502);
}

interface ImageEndpoint {
  site: 'primary' | 'backup' | 'backup2';
  baseUrl: string;
  /** 站内多把 key（逗号分隔）：逐请求轮转，死 key 冷却跳过 */
  apiKeys: string[];
  /** 文生图模型名 */
  model: string;
  /** 改图模型名（不分模型名的渠道与 model 相同） */
  editModel: string;
  /** 单张成本（分）；0 = 单价未配置（未知），排序时排在已知单价之后 */
  price: number;
}

/** 上游记账里的站点文案：线上账本/财务按站点分开统计消耗与单价 */
const IMAGE_SITE_PROVIDER: Record<ImageEndpoint['site'], UsageProvider> = {
  primary: 'image',
  backup: 'image-backup',
  backup2: 'image-backup-2',
};

/** 站内多把 key 用逗号分隔，按配置顺序轮转 */
function imageApiKeys(raw: string): string[] {
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

/** 生图站点候选：主站 → 跨站灾备 → 第二跨站灾备（每站三项齐备才挂上） */
function imageEndpoints(config: GenerationConfig): ImageEndpoint[] {
  const endpoints: ImageEndpoint[] = [];
  const primaryKeys = imageApiKeys(config.imageApiKey);
  if (config.imageBaseUrl && primaryKeys.length > 0) {
    endpoints.push({
      site: 'primary',
      baseUrl: config.imageBaseUrl,
      apiKeys: primaryKeys,
      model: config.imageModel,
      editModel: config.imageEditModel,
      price: config.costImageFenPerCall,
    });
  }
  const backupKeys = imageApiKeys(config.imageBackupApiKey);
  if (config.imageBackupBaseUrl && backupKeys.length > 0 && config.imageBackupModel) {
    endpoints.push({
      site: 'backup',
      baseUrl: config.imageBackupBaseUrl,
      apiKeys: backupKeys,
      model: config.imageBackupModel,
      editModel: config.imageBackupEditModel || config.imageBackupModel,
      price: config.costImageBackupFenPerCall,
    });
  }
  const backup2Keys = imageApiKeys(config.imageBackup2ApiKey);
  if (config.imageBackup2BaseUrl && backup2Keys.length > 0 && config.imageBackup2Model) {
    endpoints.push({
      site: 'backup2',
      baseUrl: config.imageBackup2BaseUrl,
      apiKeys: backup2Keys,
      model: config.imageBackup2Model,
      editModel: config.imageBackup2EditModel || config.imageBackup2Model,
      price: config.costImageBackup2FenPerCall,
    });
  }
  return orderByPrice(endpoints);
}

interface ImageKeyCooldown {
  until: number;
  error: unknown;
}

/** 轮换游标与死 key 冷却：模块级、每请求前进（与调度器同样挂 globalThis，避免 dev 热重载丢状态） */
interface ImagePoolState {
  rotationCursors: Map<string, number>;
  keyCursors: Map<string, number>;
  keyCooldowns: Map<string, ImageKeyCooldown>;
}

const poolGlobal = globalThis as typeof globalThis & { __anpptImagePool?: ImagePoolState };
const imagePool: ImagePoolState = poolGlobal.__anpptImagePool ?? {
  rotationCursors: new Map(),
  keyCursors: new Map(),
  keyCooldowns: new Map(),
};
poolGlobal.__anpptImagePool = imagePool;

/** 仅测试使用：清空轮换游标与冷却窗口，别依赖真实时间。 */
export function resetImagePoolForTests(): void {
  imagePool.rotationCursors.clear();
  imagePool.keyCursors.clear();
  imagePool.keyCooldowns.clear();
}

function imageEndpointId(endpoint: ImageEndpoint): string {
  return `${endpoint.site}|${endpoint.baseUrl}|${endpoint.model}|${endpoint.editModel}`;
}

function imageKeyCooldownId(endpoint: ImageEndpoint, apiKey: string): string {
  return `${imageEndpointId(endpoint)}\u0000${apiKey}`;
}

/** 401/402/403 与余额/配额耗尽：这把 key 活不了（欠费换 key 也不活），冷却后跳过；整站 key 都冷却即站点熔断 */
function isDeadImageKeyError(error: unknown): boolean {
  if (isBalanceExhausted(error)) return true;
  return error instanceof ImageUpstreamError
    && (error.status === 401 || error.status === 402 || error.status === 403);
}

function isImageKeyCooling(endpoint: ImageEndpoint, apiKey: string, now: number): boolean {
  const id = imageKeyCooldownId(endpoint, apiKey);
  const cooldown = imagePool.keyCooldowns.get(id);
  if (!cooldown) return false;
  if (cooldown.until > now) return true;
  // 冷却到点自动恢复：过期条目当场清掉，避免状态无限增长、也避免误用陈旧错误
  imagePool.keyCooldowns.delete(id);
  return false;
}

/** 站内 key 全在冷却时，用冷却中的失败原因对外报错（不新造错误码） */
function firstCoolingError(endpoint: ImageEndpoint): unknown {
  const prefix = `${imageEndpointId(endpoint)}\u0000`;
  for (const [id, cooldown] of imagePool.keyCooldowns) {
    if (id.startsWith(prefix)) return cooldown.error;
  }
  return undefined;
}

/**
 * 站内 key 轮转：从游标起取第一把不在冷却、且本请求还没试过的 key。
 * `tried` 是请求级的：冷却关闭时死 key 不进冷却表，没有它就会对同一把 key 无限重试。
 */
function takeNextImageKey(endpoint: ImageEndpoint, now: number, tried: Set<string>): string | null {
  const total = endpoint.apiKeys.length;
  if (total === 0) return null;
  const id = imageEndpointId(endpoint);
  const cursor = (imagePool.keyCursors.get(id) ?? 0) % total;
  for (let step = 0; step < total; step += 1) {
    const index = (cursor + step) % total;
    const apiKey = endpoint.apiKeys[index];
    if (tried.has(apiKey) || isImageKeyCooling(endpoint, apiKey, now)) continue;
    imagePool.keyCursors.set(id, (index + 1) % total);
    return apiKey;
  }
  return null;
}

/**
 * 同价同模型的站才成组轮转：一套 PPT 内混用不同图像模型会让风格不一致。
 * 生图不看 editModel（该请求用不到），改图才要求两者都相同。
 */
function orderPoolForRequest(endpoints: ImageEndpoint[], action: '生图' | '改图'): ImageEndpoint[] {
  const head = endpoints[0];
  if (!head || head.price <= 0) return endpoints;
  const group = endpoints.filter(
    (endpoint) => endpoint.price === head.price
      && endpoint.model === head.model
      && (action !== '改图' || endpoint.editModel === head.editModel),
  );
  if (group.length < 2) return endpoints;
  const groupKey = group.map(imageEndpointId).join('+');
  const offset = (imagePool.rotationCursors.get(groupKey) ?? 0) % group.length;
  imagePool.rotationCursors.set(groupKey, (offset + 1) % group.length);
  // 只互换组员占的槽位：同价不同模型的站留在原顺位，成本排序与回退语义不因轮换改变
  const inGroup = new Set(group);
  const rotated = [...group.slice(offset), ...group.slice(0, offset)];
  let next = 0;
  return endpoints.map((endpoint) => (inGroup.has(endpoint) ? rotated[next++] : endpoint));
}

/** 单价已知（>0）的站升序在前；单价未知的站保持配置顺序排在后面（全未配置时顺序与历史一致） */
function orderByPrice(candidates: ImageEndpoint[]): ImageEndpoint[] {
  return candidates
    .map((endpoint, index) => ({ endpoint, index }))
    .sort((a, b) => {
      const aKnown = a.endpoint.price > 0;
      const bKnown = b.endpoint.price > 0;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      if (aKnown && a.endpoint.price !== b.endpoint.price) return a.endpoint.price - b.endpoint.price;
      return a.index - b.index;
    })
    .map((item) => item.endpoint);
}

/**
 * 剩余可用站点数：站内还有一把非冷却 key 即算可用。只读冷却表（顺带清理过期条目），不推进任何游标。
 */
function availableStationCount(endpoints: ImageEndpoint[], now: number): number {
  return endpoints.filter((endpoint) => endpoint.apiKeys.some((apiKey) => !isImageKeyCooling(endpoint, apiKey, now))).length;
}

/** 健康检查用的站点快照：只暴露 host，不暴露 baseUrl/apiKeys */
export interface ImagePoolStationSnapshot {
  site: 'primary' | 'backup' | 'backup2';
  /** 仅域名[:端口]；baseUrl 解析失败时为 '' */
  host: string;
  model: string;
  editModel: string;
  /** 分/张；0 = 单价未配置 */
  price: number;
  /** 该站配置的 key 总数 */
  keys: number;
  /** 该站当前冷却中的 key 数 */
  coolingKeys: number;
  /** 整站熔断：所有 key 都在冷却，请求本轮不会再打过去 */
  cooling: boolean;
}

/**
 * 只读、零网络调用的池快照，顺序即后端候选顺序（单价升序，不含同价轮换偏移）：
 * 健康检查每分钟调用，不能推进 round-robin 游标扰动真实请求顺序。
 */
export function imagePoolSnapshot(config: GenerationConfig = getGenerationConfig(), now = Date.now()): ImagePoolStationSnapshot[] {
  return imageEndpoints(config).map((endpoint) => {
    const prefix = `${imageEndpointId(endpoint)}\u0000`;
    let coolingKeys = 0;
    for (const [id, cooldown] of imagePool.keyCooldowns) {
      if (id.startsWith(prefix) && cooldown.until > now) coolingKeys += 1;
    }
    return {
      site: endpoint.site,
      host: imageHost(endpoint.baseUrl),
      model: endpoint.model,
      editModel: endpoint.editModel,
      price: endpoint.price,
      keys: endpoint.apiKeys.length,
      coolingKeys,
      cooling: endpoint.apiKeys.length > 0 && coolingKeys >= endpoint.apiKeys.length,
    };
  });
}

/** 站点描述：站点 + 模型 + 单价 + host（切站与冷却日志共用，线上口径不变） */
function describeImageStation(action: '生图' | '改图', endpoint: ImageEndpoint): string {
  const model = action === '改图' ? endpoint.editModel : endpoint.model;
  const price = endpoint.price > 0 ? `单价 ${endpoint.price} 分/张` : '单价未配置';
  const host = imageHost(endpoint.baseUrl);
  return `${endpoint.site}（${model}，${price}）${host ? `@${host}` : ''}`;
}

/** 日志只写 key 指纹：完整 key 不进任何日志 */
function imageKeyFingerprint(apiKey: string): string {
  return apiKey.length <= 4 ? `#len${apiKey.length}` : `#${apiKey.slice(-4)}`;
}

/** 切站日志：站点 + 模型 + 单价 + host（既有 [anppt-v2][image-upstream] 前缀不变），便于线上核对命中顺序与每张成本 */
function logImageSwitch(
  action: '生图' | '改图',
  from: ImageEndpoint,
  to: ImageEndpoint,
  error: unknown,
  stations: { available: number; total: number },
): void {
  console.warn(
    `[anppt-v2][image-upstream] ${action}站 ${describeImageStation(action, from)}失败，切换 ${describeImageStation(action, to)}：${
      error instanceof Error ? error.message : String(error)
    }（剩余可用站点 ${stations.available}/${stations.total}）`,
  );
}

/** 死 key 冷却：只写 key 指纹与上游状态码，线上定位不用翻完整密钥；余额类额外点名并给秒数 */
function logImageKeyCooldown(
  action: '生图' | '改图',
  endpoint: ImageEndpoint,
  apiKey: string,
  error: unknown,
  cooldownMs: number,
  stations: { available: number; total: number },
): void {
  const status = error instanceof ImageUpstreamError ? error.status : 0;
  const reason = isBalanceExhausted(error) ? '（余额/配额耗尽，按站点故障冷却）' : '';
  console.warn(
    `[anppt-v2][image-upstream] ${action}站 ${describeImageStation(action, endpoint)} key ${imageKeyFingerprint(apiKey)} 上游 HTTP ${status}${reason} 失败，冷却 ${cooldownMs}ms（${Math.round(cooldownMs / 1000)}s），剩余可用站点 ${stations.available}/${stations.total}`,
  );
}

function logImageStationBlocked(
  action: '生图' | '改图',
  endpoint: ImageEndpoint,
  stations: { available: number; total: number },
): void {
  console.warn(
    `[anppt-v2][image-upstream] ${action}站 ${describeImageStation(action, endpoint)} 全部 key 冷却中，本轮跳过（剩余可用站点 ${stations.available}/${stations.total}）`,
  );
}

/** 400/413 是请求本身的问题，换站也必败，不浪费灾备费用；余额/配额耗尽例外（站点级故障，400 也要切） */
function isFailoverWorthy(error: unknown): boolean {
  if (isBalanceExhausted(error)) return true;
  if (error instanceof ImageUpstreamError && (error.status === 400 || error.status === 413)) return false;
  return true;
}

function isRetryableImageError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  // 余额类不重试：同一站重试只会再撞一次墙（2026-10-31 事故）
  if (isBalanceExhausted(error)) return false;
  if (error instanceof ImageUpstreamError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError || (error instanceof Error && /network|socket|fetch failed|ECONN|EAI_AGAIN/i.test(error.message));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientRecovery<T>(config: GenerationConfig, userKey: string, action: () => Promise<T>): Promise<T> {
  const retries = Math.max(0, config.imageMaxRetries || 0);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await scheduleImageRequest(config, userKey, action);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetryableImageError(error)) throw error;
      const delay = Math.min(30_000, (config.imageRetryBaseMs || 2_000) * 2 ** attempt);
      console.warn(`[anppt-v2][image-upstream] 瞬态失败，后台恢复 ${attempt + 1}/${retries}，${delay}ms 后继续`);
      await sleep(delay);
    }
  }
  throw lastError;
}

// ---- atlascloud 直连灾备：异步预测 API --------------------------------------
// 不支持 OpenAI /images/generations；走 POST /model/generateImage 创建任务，
// GET /model/prediction/{id} 轮询，completed 后下载 outputs[0] 结果图。
const ATLAS_POLL_INTERVAL_MS = 3_000;

function isAtlasEndpoint(ep: ImageEndpoint): boolean {
  return /atlascloud/i.test(ep.baseUrl);
}

interface AtlasEnvelope<T> {
  code?: number;
  data?: T;
  message?: string;
}

async function atlasHttp<T>(
  ep: ImageEndpoint,
  apiKey: string,
  path: string,
  init: { method: string; body?: unknown },
  timeoutMs: number,
  deps: ImageDeps,
  station: ImageStationLog,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl(`${ep.baseUrl}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: AtlasEnvelope<T> = {};
    try {
      payload = text ? (JSON.parse(text) as AtlasEnvelope<T>) : {};
    } catch {
      throw new ImageUpstreamError(`HTTP ${response.status}: 上游返回非 JSON`, response.status || 502);
    }
    // atlascloud 业务错误也可能以 HTTP 200 + code!==200 返回
    if (!response.ok || (typeof payload.code === 'number' && payload.code !== 200)) {
      const error = new ImageUpstreamError(
        `HTTP ${response.status}: ${cleanString(payload?.message, 300) || 'atlascloud upstream error'}`,
        response.status || 502,
        cleanString(text, 300),
      );
      logProblem({
        category: 'image-upstream',
        level: 'error',
        message: `atlas 生图上游 HTTP ${response.status}${typeof payload.code === 'number' ? ` code=${payload.code}` : ''}`,
        detail: {
          ...station,
          status: response.status,
          balance: isBalanceExhausted(error),
          upstream: cleanString(text, 500),
        },
      });
      throw error;
    }
    if (!payload.data) throw new ImageUpstreamError('atlascloud 返回缺少 data', 502);
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function atlasRunImageJob(
  ep: ImageEndpoint,
  apiKey: string,
  body: Record<string, unknown>,
  config: GenerationConfig,
  deps: ImageDeps,
  station: ImageStationLog,
): Promise<Buffer> {
  const created = await atlasHttp<{ id?: string }>(ep, apiKey, '/model/generateImage', { method: 'POST', body }, 90_000, deps, station);
  if (!created.id) throw new ImageUpstreamError('atlascloud 未返回任务 id', 502);
  const deadline = Date.now() + config.imageTimeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new ImageUpstreamError('atlascloud 出图等待超时', 504);
    await sleep(ATLAS_POLL_INTERVAL_MS);
    const prediction = await atlasHttp<{ status?: string; outputs?: string[]; error?: string }>(
      ep,
      apiKey,
      `/model/prediction/${created.id}`,
      { method: 'GET' },
      30_000,
      deps,
      station,
    );
    const status = String(prediction.status || '').toLowerCase();
    if (status === 'completed' || status === 'succeeded') {
      const url = prediction.outputs?.[0];
      if (!url) throw new ImageUpstreamError('atlascloud 完成但无输出图', 502);
      const fetchImpl = deps.fetchImpl ?? fetch;
      const imageResponse = await fetchImpl(url);
      if (!imageResponse.ok) {
        throw new ImageUpstreamError(`HTTP ${imageResponse.status}: 图片下载失败`, imageResponse.status);
      }
      return Buffer.from(await imageResponse.arrayBuffer());
    }
    if (status === 'failed' || status === 'canceled') {
      throw new ImageUpstreamError(`atlascloud 任务失败：${cleanString(prediction.error, 200) || status}`, 502);
    }
  }
}

export interface GenerateImageInput {
  prompt: string;
  referenceImages?: string[];
  size?: string;
  /** 用于多用户公平调度；匿名调用回退到 anonymous */
  userKey?: string;
}

interface ImagePoolFailure {
  endpoint: ImageEndpoint;
  error: unknown;
}

/**
 * 站点池唯一入口：同价同模型轮转起点 → 站内 key 轮转 → 死 key/余额耗尽冷却跳过 → 逐站按单价回退。
 * 400/413 通常是请求本身的问题，不换 key 也不换站；余额/配额耗尽例外，按站点故障切站并冷却该 key。
 * 整池都在冷却时用最近一次冷却错误对外报错。
 */
async function runImagePool(
  config: GenerationConfig,
  action: '生图' | '改图',
  userKey: string,
  deps: ImageDeps,
  attempt: (endpoint: ImageEndpoint, apiKey: string) => Promise<Buffer>,
): Promise<Buffer> {
  const endpoints = orderPoolForRequest(imageEndpoints(config), action);
  if (endpoints.length === 0) {
    throw new ImageUpstreamError('生图服务未配置（ANPPT_V2_IMAGE_BASE_URL/API_KEY）', 503);
  }
  const cooldownMs = Math.max(0, config.imageKeyCooldownMs);
  const clock = deps.now ?? Date.now;
  const stationCounts = (): { available: number; total: number } => ({
    available: availableStationCount(endpoints, clock()),
    total: endpoints.length,
  });
  let lastError: unknown;
  let blockedError: unknown;
  let failed: ImagePoolFailure | null = null;
  for (const endpoint of endpoints) {
    const triedKeys = new Set<string>();
    let currentKey = takeNextImageKey(endpoint, clock(), triedKeys);
    if (!currentKey) {
      logImageStationBlocked(action, endpoint, stationCounts());
      blockedError ??= firstCoolingError(endpoint);
      continue;
    }
    if (failed) {
      logImageSwitch(action, failed.endpoint, endpoint, failed.error, stationCounts());
      failed = null;
    }
    for (;;) {
      const apiKey = currentKey;
      triedKeys.add(apiKey);
      try {
        const image = await withTransientRecovery(config, userKey, () => attempt(endpoint, apiKey));
        imagePool.keyCooldowns.delete(imageKeyCooldownId(endpoint, apiKey));
        return image;
      } catch (error) {
        lastError = error;
        if (isDeadImageKeyError(error)) {
          if (cooldownMs > 0) {
            imagePool.keyCooldowns.set(imageKeyCooldownId(endpoint, apiKey), {
              until: clock() + cooldownMs,
              error,
            });
            logImageKeyCooldown(action, endpoint, apiKey, error, cooldownMs, stationCounts());
          }
          const nextKey = takeNextImageKey(endpoint, clock(), triedKeys);
          if (nextKey) {
            currentKey = nextKey;
            continue;
          }
          failed = { endpoint, error };
          break;
        }
        if (!isFailoverWorthy(error)) throw error;
        failed = { endpoint, error };
        break;
      }
    }
  }
  if (lastError) throw lastError;
  if (blockedError) throw blockedError;
  throw new ImageUpstreamError('生图站点池无可用 key（全部冷却中）', 503);
}

export async function generateImage(input: GenerateImageInput, deps: ImageDeps = {}): Promise<Buffer> {
  const config = deps.config ?? getGenerationConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  return runImagePool(config, '生图', input.userKey || 'anonymous', deps, async (ep, apiKey) => {
    const provider = IMAGE_SITE_PROVIDER[ep.site];
    const startedAt = Date.now();
    if (isAtlasEndpoint(ep)) {
      try {
        const image = await atlasRunImageJob(
          ep,
          apiKey,
          {
            model: ep.model,
            prompt: input.prompt,
            size: input.size || config.imageSize,
            enable_sync_mode: false,
            enable_base64_output: false,
          },
          config,
          deps,
          imageStationLog(ep, '生图'),
        );
        recordUpstreamUsage({
          provider, kind: 'image-generate', model: ep.model,
          status: 'ok', units: 1, durationMs: Date.now() - startedAt,
        });
        return image;
      } catch (error) {
        recordUpstreamUsage({
          provider, kind: 'image-generate', model: ep.model,
          status: 'error', durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.imageTimeoutMs);
    try {
      const response = await fetchImpl(`${ep.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: ep.model,
          prompt: input.prompt,
          size: input.size || config.imageSize,
          n: 1,
          ...(input.referenceImages && input.referenceImages.length > 0
            ? { reference_images: input.referenceImages.map((url) => ({ url })) }
            : {}),
        }),
        signal: controller.signal,
      });
      const image = await parseImageResponse(response, deps, imageStationLog(ep, '生图'), controller.signal);
      recordUpstreamUsage({
        provider, kind: 'image-generate', model: ep.model,
        status: 'ok', units: 1, durationMs: Date.now() - startedAt,
      });
      return image;
    } catch (error) {
      recordUpstreamUsage({
        provider, kind: 'image-generate', model: ep.model,
        status: 'error', durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
}

export interface EditImageInput {
  image: Buffer;
  instruction: string;
  size?: string;
  /** 用于多用户公平调度；匿名调用回退到 anonymous */
  userKey?: string;
  /** 追加的参考/标记图（主站 /images/edits 支持多 image 字段）；atlascloud 灾备多图支持未知，降级见 extraImageNote */
  extraImages?: Buffer[];
  /** 走灾备丢图时把第二图意图以文字描述拼进 prompt，并如实记日志 */
  extraImageNote?: string;
}

export async function editImage(input: EditImageInput, deps: ImageDeps = {}): Promise<Buffer> {
  const config = deps.config ?? getGenerationConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  return runImagePool(config, '改图', input.userKey || 'anonymous', deps, async (ep, apiKey) => {
    const provider = IMAGE_SITE_PROVIDER[ep.site];
    const extraImages = (input.extraImages || []).filter((item) => item && item.length > 0);
    // atlascloud 多图编辑支持未验证：灾备只发原图，第二图意图降级为文字描述
    const degraded = extraImages.length > 0 && isAtlasEndpoint(ep);
    const instruction = degraded && input.extraImageNote
      ? `${input.instruction}\n\n${input.extraImageNote}`
      : input.instruction;
    const form = new FormData();
    form.append('model', ep.editModel);
    form.append('prompt', instruction);
    form.append('size', input.size || config.imageSize);
    form.append('image', new Blob([new Uint8Array(input.image)], { type: 'image/png' }), 'source.png');
    extraImages.forEach((extra, index) => {
      form.append('image', new Blob([new Uint8Array(extra)], { type: 'image/png' }), `extra-${index + 1}.png`);
    });
    const startedAt = Date.now();
    if (isAtlasEndpoint(ep)) {
      if (degraded) {
        console.warn('[anppt-v2][image-upstream] 灾备渠道多图编辑未验证：已丢弃附加图，意图转为文字描述');
      }
      try {
        const image = await atlasRunImageJob(
          ep,
          apiKey,
          {
            model: ep.editModel,
            prompt: instruction,
            image: `data:image/png;base64,${input.image.toString('base64')}`,
            size: input.size || config.imageSize,
            enable_sync_mode: false,
            enable_base64_output: false,
          },
          config,
          deps,
          imageStationLog(ep, '改图'),
        );
        recordUpstreamUsage({
          provider, kind: 'image-edit', model: ep.editModel,
          status: 'ok', units: 1, durationMs: Date.now() - startedAt,
        });
        return image;
      } catch (error) {
        recordUpstreamUsage({
          provider, kind: 'image-edit', model: ep.editModel,
          status: 'error', durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.imageTimeoutMs);
    try {
      const response = await fetchImpl(`${ep.baseUrl}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      const image = await parseImageResponse(response, deps, imageStationLog(ep, '改图'), controller.signal);
      recordUpstreamUsage({
        provider, kind: 'image-edit', model: ep.editModel,
        status: 'ok', units: 1, durationMs: Date.now() - startedAt,
      });
      return image;
    } catch (error) {
      recordUpstreamUsage({
        provider, kind: 'image-edit', model: ep.editModel,
        status: 'error', durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
}
