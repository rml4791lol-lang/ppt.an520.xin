// gpt-image-2 生图上游客户端。站点池（主站 + 两站跨站灾备）按单价升序尝试、失败逐站回退；
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
}

export class ImageUpstreamError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'ImageUpstreamError';
    this.status = status;
  }
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
  if (/未配置/.test(message)) {
    return { code: 'IMAGE_NOT_CONFIGURED', message: '生图服务尚未配置，请联系管理员', status: 503 };
  }
  if (/401|403/.test(message)) {
    return { code: 'IMAGE_UPSTREAM_UNAVAILABLE', message: '图片服务暂时不可用，星星已退回', status: 502 };
  }
  if (/400|413/.test(message)) {
    return { code: 'IMAGE_REQUEST_INVALID', message: '本页素材或文字内容可能过长，请简化后再生成', status: 400 };
  }
  if (/429/.test(message)) {
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

async function parseImageResponse(
  response: Response,
  deps: ImageDeps,
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
    logProblem({
      category: 'image-upstream',
      level: 'error',
      message: `生图上游 HTTP ${response.status}`,
      detail: text.slice(0, 500),
    });
    throw new ImageUpstreamError(
      `HTTP ${response.status}: ${cleanString(payload?.error?.message, 300) || 'upstream error'}`,
      response.status,
    );
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
  apiKey: string;
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

/** 站内多把 key 先按逗号解析成数组；当前只使用第一把（轮换与冷却尚未接入） */
function imageApiKeys(raw: string): string[] {
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

/** 生图站点候选：主站 → 跨站灾备 → 第二跨站灾备（每站三项齐备才挂上） */
function imageEndpoints(config: GenerationConfig): ImageEndpoint[] {
  const endpoints: ImageEndpoint[] = [];
  const [primaryKey] = imageApiKeys(config.imageApiKey);
  if (config.imageBaseUrl && primaryKey) {
    endpoints.push({
      site: 'primary',
      baseUrl: config.imageBaseUrl,
      apiKey: primaryKey,
      model: config.imageModel,
      editModel: config.imageEditModel,
      price: config.costImageFenPerCall,
    });
  }
  const [backupKey] = imageApiKeys(config.imageBackupApiKey);
  if (config.imageBackupBaseUrl && backupKey && config.imageBackupModel) {
    endpoints.push({
      site: 'backup',
      baseUrl: config.imageBackupBaseUrl,
      apiKey: backupKey,
      model: config.imageBackupModel,
      editModel: config.imageBackupEditModel || config.imageBackupModel,
      price: config.costImageBackupFenPerCall,
    });
  }
  const [backup2Key] = imageApiKeys(config.imageBackup2ApiKey);
  if (config.imageBackup2BaseUrl && backup2Key && config.imageBackup2Model) {
    endpoints.push({
      site: 'backup2',
      baseUrl: config.imageBackup2BaseUrl,
      apiKey: backup2Key,
      model: config.imageBackup2Model,
      editModel: config.imageBackup2EditModel || config.imageBackup2Model,
      price: config.costImageBackup2FenPerCall,
    });
  }
  return orderByPrice(endpoints);
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

/** 切站日志：站点 + 模型 + 单价（既有 [anppt-v2][image-upstream] 前缀不变），便于线上核对命中顺序与每张成本 */
function logImageSwitch(action: '生图' | '改图', from: ImageEndpoint, to: ImageEndpoint, error: unknown): void {
  const describe = (endpoint: ImageEndpoint) => {
    const model = action === '改图' ? endpoint.editModel : endpoint.model;
    const price = endpoint.price > 0 ? `单价 ${endpoint.price} 分/张` : '单价未配置';
    return `${endpoint.site}（${model}，${price}）`;
  };
  console.warn(
    `[anppt-v2][image-upstream] ${action}站 ${describe(from)}失败，切换 ${describe(to)}：${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

/** 400/413 是请求本身的问题，换站也必败，不浪费灾备费用；其余（402/401/429/5xx/网络/超时）都可切站 */
function isFailoverWorthy(error: unknown): boolean {
  if (error instanceof ImageUpstreamError && (error.status === 400 || error.status === 413)) return false;
  return true;
}

function isRetryableImageError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
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
  path: string,
  init: { method: string; body?: unknown },
  timeoutMs: number,
  deps: ImageDeps = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const response = await fetchImpl(`${ep.baseUrl}${path}`, {
      method: init.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
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
      logProblem({
        category: 'image-upstream',
        level: 'error',
        message: `atlas 生图上游 HTTP ${response.status}${typeof payload.code === 'number' ? ` code=${payload.code}` : ''}`,
        detail: text.slice(0, 500),
      });
      throw new ImageUpstreamError(
        `HTTP ${response.status}: ${cleanString(payload?.message, 300) || 'atlascloud upstream error'}`,
        response.status || 502,
      );
    }
    if (!payload.data) throw new ImageUpstreamError('atlascloud 返回缺少 data', 502);
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

async function atlasRunImageJob(
  ep: ImageEndpoint,
  body: Record<string, unknown>,
  config: GenerationConfig,
  deps: ImageDeps,
): Promise<Buffer> {
  const created = await atlasHttp<{ id?: string }>(ep, '/model/generateImage', { method: 'POST', body }, 90_000, deps);
  if (!created.id) throw new ImageUpstreamError('atlascloud 未返回任务 id', 502);
  const deadline = Date.now() + config.imageTimeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new ImageUpstreamError('atlascloud 出图等待超时', 504);
    await sleep(ATLAS_POLL_INTERVAL_MS);
    const prediction = await atlasHttp<{ status?: string; outputs?: string[]; error?: string }>(
      ep,
      `/model/prediction/${created.id}`,
      { method: 'GET' },
      30_000,
      deps,
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

export async function generateImage(input: GenerateImageInput, deps: ImageDeps = {}): Promise<Buffer> {
  const config = deps.config ?? getGenerationConfig();
  const endpoints = imageEndpoints(config);
  if (endpoints.length === 0) {
    throw new ImageUpstreamError('生图服务未配置（ANPPT_V2_IMAGE_BASE_URL/API_KEY）', 503);
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let i = 0; i < endpoints.length; i += 1) {
    const ep = endpoints[i];
    const provider = IMAGE_SITE_PROVIDER[ep.site];
    try {
      return await withTransientRecovery(config, input.userKey || 'anonymous', async () => {
        const startedAt = Date.now();
        if (isAtlasEndpoint(ep)) {
          try {
            const image = await atlasRunImageJob(
              ep,
              {
                model: ep.model,
                prompt: input.prompt,
                size: input.size || config.imageSize,
                enable_sync_mode: false,
                enable_base64_output: false,
              },
              config,
              deps,
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
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
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
          const image = await parseImageResponse(response, deps, controller.signal);
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
    } catch (error) {
      lastError = error;
      if (i >= endpoints.length - 1 || !isFailoverWorthy(error)) throw error;
      logImageSwitch('生图', ep, endpoints[i + 1], error);
    }
  }
  throw lastError instanceof Error ? lastError : new ImageUpstreamError('生图上游全部站点失败', 502);
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
  const endpoints = imageEndpoints(config);
  if (endpoints.length === 0) {
    throw new ImageUpstreamError('生图服务未配置（ANPPT_V2_IMAGE_BASE_URL/API_KEY）', 503);
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let i = 0; i < endpoints.length; i += 1) {
    const ep = endpoints[i];
    const provider = IMAGE_SITE_PROVIDER[ep.site];
    try {
      return await withTransientRecovery(config, input.userKey || 'anonymous', async () => {
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
            headers: { Authorization: `Bearer ${ep.apiKey}` },
            body: form,
            signal: controller.signal,
          });
          const image = await parseImageResponse(response, deps, controller.signal);
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
    } catch (error) {
      lastError = error;
      if (i >= endpoints.length - 1 || !isFailoverWorthy(error)) throw error;
      logImageSwitch('改图', ep, endpoints[i + 1], error);
    }
  }
  throw lastError instanceof Error ? lastError : new ImageUpstreamError('改图上游全部站点失败', 502);
}
