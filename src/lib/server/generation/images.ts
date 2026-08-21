// gpt-image-2 生图上游客户端（OpenAI 兼容 /images/generations + /images/edits）。
// 所有真实请求经过全局并发/启动速率调度，并只对瞬态错误做有限后台恢复。
import { getGenerationConfig, type GenerationConfig } from './config';
import { cleanString } from './types';

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
}

const schedulerGlobal = globalThis as typeof globalThis & {
  __anpptImageScheduler?: {
    active: number;
    starts: number[];
    queue: ScheduledTask<unknown>[];
    timer: ReturnType<typeof setTimeout> | null;
  };
};
const scheduler = schedulerGlobal.__anpptImageScheduler ?? {
  active: 0,
  starts: [],
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
  const next = scheduler.queue[0];
  if (scheduler.active >= next.maxConcurrent) return;
  if (scheduler.starts.length >= next.startsPerMinute) {
    const waitMs = Math.max(10, 60_000 - (now - scheduler.starts[0]) + 5);
    scheduler.timer = setTimeout(pumpScheduler, waitMs);
    return;
  }
  scheduler.queue.shift();
  scheduler.active += 1;
  scheduler.starts.push(now);
  next.run().then(next.resolve, next.reject).finally(() => {
    scheduler.active -= 1;
    pumpScheduler();
  });
  queueMicrotask(pumpScheduler);
}

function scheduleImageRequest<T>(config: GenerationConfig, run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    scheduler.queue.push({
      run,
      resolve: resolve as (value: unknown) => void,
      reject,
      maxConcurrent: Math.max(1, config.imageGlobalConcurrency || 20),
      startsPerMinute: Math.max(1, config.imageStartsPerMinute || 24),
    });
    pumpScheduler();
  });
}

/** 仅测试使用，生产代码不要调用。 */
export function resetImageSchedulerForTests(): void {
  if (scheduler.timer) clearTimeout(scheduler.timer);
  scheduler.active = 0;
  scheduler.starts = [];
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
    console.error(`[anppt-v2][image-upstream] HTTP ${response.status}: ${text.slice(0, 500)}`);
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

function requireImageConfig(config: GenerationConfig): { baseUrl: string; apiKey: string } {
  if (!config.imageBaseUrl || !config.imageApiKey) {
    throw new ImageUpstreamError('生图服务未配置（ANPPT_V2_IMAGE_BASE_URL/API_KEY）', 503);
  }
  return { baseUrl: config.imageBaseUrl, apiKey: config.imageApiKey };
}

function isRetryableImageError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof ImageUpstreamError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError || (error instanceof Error && /network|socket|fetch failed|ECONN|EAI_AGAIN/i.test(error.message));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTransientRecovery<T>(config: GenerationConfig, action: () => Promise<T>): Promise<T> {
  const retries = Math.max(0, config.imageMaxRetries || 0);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await scheduleImageRequest(config, action);
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

export interface GenerateImageInput {
  prompt: string;
  referenceImages?: string[];
  size?: string;
}

export async function generateImage(input: GenerateImageInput, deps: ImageDeps = {}): Promise<Buffer> {
  const config = deps.config ?? getGenerationConfig();
  const { baseUrl, apiKey } = requireImageConfig(config);
  const fetchImpl = deps.fetchImpl ?? fetch;
  return withTransientRecovery(config, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.imageTimeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: config.imageModel,
          prompt: input.prompt,
          size: input.size || config.imageSize,
          n: 1,
          ...(input.referenceImages && input.referenceImages.length > 0
            ? { reference_images: input.referenceImages.map((url) => ({ url })) }
            : {}),
        }),
        signal: controller.signal,
      });
      return await parseImageResponse(response, deps, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  });
}

export interface EditImageInput {
  image: Buffer;
  instruction: string;
  size?: string;
}

export async function editImage(input: EditImageInput, deps: ImageDeps = {}): Promise<Buffer> {
  const config = deps.config ?? getGenerationConfig();
  const { baseUrl, apiKey } = requireImageConfig(config);
  const fetchImpl = deps.fetchImpl ?? fetch;
  return withTransientRecovery(config, async () => {
    const form = new FormData();
    form.append('model', config.imageModel);
    form.append('prompt', input.instruction);
    form.append('size', input.size || config.imageSize);
    form.append('image', new Blob([new Uint8Array(input.image)], { type: 'image/png' }), 'source.png');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.imageTimeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}/images/edits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });
      return await parseImageResponse(response, deps, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  });
}
