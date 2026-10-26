// Image2PPT 开放 API 客户端（image/PDF → 原生可编辑 PPTX）。
// 契约：POST /api/v1/jobs（multipart，异步）→ GET /api/v1/jobs/{id} → GET /api/v1/jobs/{id}/download。
// 全部经依赖注入 fetcher，测试只 mock，不触发真实付费调用。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@/lib/server/http';
import { getEnv } from '@/lib/server/env';
import { getGenerationConfig, type GenerationConfig } from '@/lib/server/generation/config';
import { cleanString } from '@/lib/server/generation/types';
import { recordUpstreamUsage } from '@/lib/server/usage-meter';

export interface Image2PptDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
  /** 测试用：覆盖请求自动恢复的退避时间。 */
  retryDelayMs?: number;
}

export interface Image2PptJobView {
  jobId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number;
  slideCount: number;
  creditsUsed: number;
  creditsRefunded: number;
  downloadUrl: string;
  error: string;
  pageResults: Array<{ pageNumber: number; status: string }>;
}

const REQUEST_TIMEOUT_MS = 90_000;
const UPLOAD_TIMEOUT_MS = 480_000;
const UPSTREAM_BUSY_MESSAGE = '可编辑转换服务暂时开小差了，系统会继续检查；完成后可在下载中心查看。';

function requireImage2PptConfig(config: GenerationConfig): { baseUrl: string; apiKey: string } {
  if (!config.image2pptApiKey) {
    throw new ApiError('EDITABLE_EXPORT_UNAVAILABLE', '可编辑转换服务尚未配置，请联系管理员', 503, false);
  }
  return { baseUrl: config.image2pptBaseUrl, apiKey: config.image2pptApiKey };
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function statusOf(value: unknown): Image2PptJobView['status'] {
  const status = cleanString(value, 40).toLowerCase();
  return status === 'processing' || status === 'completed' || status === 'failed'
    ? status
    : 'pending';
}

function resolveDownloadUrl(baseUrl: string, value: unknown): string {
  const raw = cleanString(value, 1000);
  if (!raw) return '';
  try {
    const base = new URL(baseUrl);
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' || url.host !== base.host) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function retryDelay(attempt: number, deps: Image2PptDeps): Promise<void> {
  const baseMs = Math.max(0, deps.retryDelayMs ?? 600);
  return new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** attempt));
}

function mapNetworkError(error: unknown): ApiError {
  const timedOut = error instanceof Error && error.name === 'AbortError';
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[anppt-v2][image2ppt] ${timedOut ? 'request timeout' : 'network error'}: ${cleanString(detail, 500)}`);
  return new ApiError('IMAGE2PPT_UPSTREAM_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
}

function mapHttpError(status: number, payload: Record<string, unknown>): ApiError {
  const errorObject = payload.error && typeof payload.error === 'object'
    ? payload.error as Record<string, unknown>
    : {};
  const message = cleanString(errorObject.message ?? payload.message, 300) || `HTTP ${status}`;
  console.error(`[anppt-v2][image2ppt] HTTP ${status}: ${message}`);
  if (status === 401 || status === 403) {
    return new ApiError('UPSTREAM_AUTH', '可编辑转换服务配置异常，请联系管理员。', 502, false);
  }
  if (status === 402) {
    return new ApiError('UPSTREAM_NO_CREDITS', '可编辑转换服务额度暂时不足，请联系管理员。', 502, false);
  }
  if (status === 429) {
    return new ApiError('IMAGE2PPT_RATE_LIMITED', UPSTREAM_BUSY_MESSAGE, 429, true);
  }
  if (status >= 500) {
    return new ApiError('IMAGE2PPT_UPSTREAM_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
  }
  if (status === 413) {
    return new ApiError('IMAGE2PPT_BAD_REQUEST', '文件或页数超过转换服务限制，请减少页数或压缩后重试。', 400, false);
  }
  return new ApiError('IMAGE2PPT_BAD_REQUEST', '可编辑转换请求未被服务接受，请检查文件格式和页数。', 400, false);
}

async function image2PptRequest(
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: () => BodyInit; idempotencyKey?: string; timeoutMs: number },
  deps: Image2PptDeps,
): Promise<Record<string, unknown>> {
  const config = deps.config ?? getGenerationConfig();
  const { baseUrl, apiKey } = requireImage2PptConfig(config);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  // POST 带幂等键可安全重试；GET 仅在网络/429/5xx 时短退避。
  const maxAttempts = method === 'GET' || opts.idempotencyKey ? (method === 'GET' ? 3 : 2) : 1;
  let lastError: ApiError | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.body?.(),
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      const text = await response.text();
      let payload: Record<string, unknown> = {};
      try {
        payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      } catch {
        console.error(`[anppt-v2][image2ppt] HTTP ${response.status}: non-JSON response`);
        if (!response.ok) throw mapHttpError(response.status, {});
        throw new ApiError('IMAGE2PPT_UPSTREAM_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
      }
      if (!response.ok) throw mapHttpError(response.status, payload);
      return payload;
    } catch (error) {
      lastError = error instanceof ApiError ? error : mapNetworkError(error);
      if (!lastError.retryable || attempt === maxAttempts - 1) throw lastError;
      console.warn(`[anppt-v2][image2ppt] request retry ${attempt + 1}/${maxAttempts - 1}: ${method} ${path}`);
      await retryDelay(attempt, deps);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ApiError('IMAGE2PPT_UPSTREAM_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
}

export function image2PptAuthHeaders(config: GenerationConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.image2pptApiKey}` };
}

/** 生成公开 webhook 地址；本地/HTTP 环境不传 callback，继续靠轮询收敛。 */
export function image2PptCallbackUrl(): string {
  try {
    const base = getEnv().publicBaseUrl;
    if (!base || !base.startsWith('https://')) return '';
    const url = new URL('/api/webhooks/image2ppt', base);
    if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 提交转换任务；回调地址只在生产 HTTPS 公网地址下携带。 */
export async function submitJob(
  input: { pdf: Buffer; filename: string; pageCount: number; idempotencyKey: string; callbackUrl?: string },
  deps: Image2PptDeps = {},
): Promise<{ jobId: string; status: string; slideCount: number; creditsReserved: number }> {
  const startedAt = Date.now();
  try {
    const data = await image2PptRequest(
      'POST',
      '/api/v1/jobs',
      {
        idempotencyKey: input.idempotencyKey,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        body: () => {
          const form = new FormData();
          form.append('files', new Blob([new Uint8Array(input.pdf)], { type: 'application/pdf' }), input.filename);
          form.append('locale', 'zh-CN');
          form.append('aspectRatio', 'auto');
          if (input.callbackUrl) form.append('callbackUrl', input.callbackUrl);
          return form;
        },
      },
      deps,
    );
    const jobId = cleanString(data.jobId, 200);
    if (!jobId) throw new ApiError('IMAGE2PPT_UPSTREAM_ERROR', UPSTREAM_BUSY_MESSAGE, 502, true);
    recordUpstreamUsage({
      provider: 'image2ppt',
      kind: 'image-to-ppt',
      status: 'ok',
      units: Math.max(1, input.pageCount),
      durationMs: Date.now() - startedAt,
    });
    return {
      jobId,
      status: cleanString(data.status, 40) || 'pending',
      slideCount: finiteNumber(data.slideCount),
      creditsReserved: finiteNumber(data.creditsReserved),
    };
  } catch (error) {
    recordUpstreamUsage({
      provider: 'image2ppt',
      kind: 'image-to-ppt',
      status: 'error',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** 查询任务状态。官方建议轮询数秒一次，由调用方控制节奏。 */
export async function getJob(jobId: string, deps: Image2PptDeps = {}): Promise<Image2PptJobView> {
  const config = deps.config ?? getGenerationConfig();
  const data = await image2PptRequest(
    'GET',
    `/api/v1/jobs/${encodeURIComponent(jobId)}`,
    { timeoutMs: REQUEST_TIMEOUT_MS },
    { ...deps, config },
  );
  const errorObject = data.error && typeof data.error === 'object'
    ? data.error as Record<string, unknown>
    : {};
  const pageResults = Array.isArray(data.pageResults)
    ? data.pageResults
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
        .map((item) => ({
          pageNumber: finiteNumber(item.pageNumber),
          status: cleanString(item.status, 40),
        }))
    : [];
  return {
    jobId: cleanString(data.jobId, 200) || jobId,
    status: statusOf(data.status),
    progress: Math.min(100, Math.max(0, Math.round(finiteNumber(data.progress)))),
    slideCount: finiteNumber(data.slideCount),
    creditsUsed: finiteNumber(data.creditsUsed),
    creditsRefunded: finiteNumber(data.creditsRefunded),
    downloadUrl: resolveDownloadUrl(config.image2pptBaseUrl, data.downloadUrl),
    error: cleanString(errorObject.message ?? data.error, 500),
    pageResults,
  };
}

/** Standard Webhooks 签名校验：HMAC-SHA256(id.timestamp.body)。 */
export function verifyImage2PptWebhook(rawBody: string, headers: Headers, secret: string): boolean {
  if (!secret) return false;
  const id = headers.get('webhook-id') || '';
  const timestamp = headers.get('webhook-timestamp') || '';
  const signature = headers.get('webhook-signature') || '';
  if (!id || !timestamp || !signature) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > 300) return false;
  const encoded = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 0) return false;
  const expected = Buffer.from(
    createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64'),
  );
  return signature
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => {
      const candidate = Buffer.from(part.startsWith('v1,') ? part.slice(3) : part);
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
}
