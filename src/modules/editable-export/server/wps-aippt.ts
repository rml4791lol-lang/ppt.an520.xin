// WPS AIPPT 图片/PDF 转可编辑 PPTX。上游是 WPS 网页版内部链路：
// 换取 KS3 上传凭证 → PUT PDF → SSE 转换 → 下载 PPTX。
// 该链路没有公开 API 契约，必须由配置的 WPS 登录态驱动；失败由 editable.ts 回退 Codia。
import { createHash } from 'node:crypto';
import { ApiError } from '@/lib/server/http';
import { getGenerationConfig, type GenerationConfig } from '@/lib/server/generation/config';
import { cleanString } from '@/lib/server/generation/types';
import { recordUpstreamUsage } from '@/lib/server/usage-meter';
import {
  finiteNumber,
  notConfiguredError,
  UPSTREAM_AUTH_MESSAGE,
  UPSTREAM_BUSY_MESSAGE,
} from './providers/types';

const TOKEN_TIMEOUT_MS = 30_000;
const CONVERT_TIMEOUT_MS = 300_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const RATE_LIMIT_COOLDOWN_MS = 600_000;

let wpsRateLimitedUntil = 0;

export interface WpsAipptDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
  /** 测试用：覆盖转换等待上限。 */
  timeoutMs?: number;
  /** 转换进度（0-100），用于导出中心展示。 */
  onProgress?: (progress: number) => void;
}

export interface WpsAipptResult {
  bytes: Buffer;
  pageCount: number;
  durationMs: number;
  docId: string;
  fileName: string;
}

interface WpsEnvelope {
  code?: number;
  msg?: string;
  message?: string;
  error?: string;
  data?: Record<string, unknown>;
}

interface UploadRequest {
  method?: string;
  headers?: Record<string, string>;
  object_key?: string;
  object_url?: string;
}

function requireWpsConfig(config: GenerationConfig): { baseUrl: string; cookie: string } {
  const cookie = String(config.wpsAipptCookie || '').trim();
  if (!cookie) throw notConfiguredError();
  if (/[\r\n]/.test(cookie)) {
    throw new ApiError('EDITABLE_EXPORT_UNAVAILABLE', UPSTREAM_AUTH_MESSAGE, 503, false);
  }
  return { baseUrl: config.wpsAipptBaseUrl.replace(/\/+$/, ''), cookie };
}

function mapNetworkError(error: unknown): ApiError {
  const timedOut = error instanceof Error && error.name === 'AbortError';
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[anppt-v2][wps-aippt] ${timedOut ? 'request timeout' : 'network error'}: ${cleanString(detail, 400)}`);
  return new ApiError('WPS_AIPPT_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
}

function mapBusinessError(payload: WpsEnvelope, status = 200): ApiError {
  const code = Number(payload.code);
  const message = cleanString(payload.error || payload.msg || payload.message, 240) || `code ${code || status}`;
  console.error(`[anppt-v2][wps-aippt] business error ${code || status}: ${message}`);
  if (code === 10712 || cleanString(payload.msg, 80) === 'convert2pptxRateLimited') {
    wpsRateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    return new ApiError('WPS_AIPPT_RATE_LIMITED', UPSTREAM_BUSY_MESSAGE, 429, true);
  }
  if (code === 1011 || code === 1012 || code === 1013 || status === 401 || status === 403) {
    return new ApiError('WPS_AIPPT_AUTH_EXPIRED', '可编辑转换服务登录态已失效，请联系管理员更新。', 503, false);
  }
  if (status === 429) {
    return new ApiError('WPS_AIPPT_RATE_LIMITED', UPSTREAM_BUSY_MESSAGE, 429, true);
  }
  if (status >= 500) {
    return new ApiError('WPS_AIPPT_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
  }
  return new ApiError('WPS_AIPPT_UPSTREAM_ERROR', '可编辑转换服务返回异常，请稍后重试。', 502, false);
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<WpsEnvelope> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: WpsEnvelope = {};
    try {
      payload = text ? (JSON.parse(text) as WpsEnvelope) : {};
    } catch {
      if (!response.ok) throw mapBusinessError({}, response.status);
      throw new ApiError('WPS_AIPPT_UPSTREAM_ERROR', '可编辑转换服务返回非 JSON 响应。', 502, true);
    }
    if (!response.ok) throw mapBusinessError(payload, response.status);
    if (Number(payload.code ?? 0) !== 0) throw mapBusinessError(payload, response.status);
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw mapNetworkError(error);
  } finally {
    clearTimeout(timer);
  }
}

function parseSseEvent(chunk: string): Record<string, unknown> | null {
  const data = chunk
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data) return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    throw new ApiError('WPS_AIPPT_UPSTREAM_ERROR', '可编辑转换服务进度流格式异常。', 502, true);
  }
}

async function readConversionStream(
  response: Response,
  onProgress?: (progress: number) => void,
): Promise<Record<string, unknown>> {
  if (!response.body) {
    throw new ApiError('WPS_AIPPT_UPSTREAM_ERROR', '可编辑转换服务未返回进度流。', 502, true);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finish: Record<string, unknown> | null = null;

  const consume = (chunk: string) => {
    const event = parseSseEvent(chunk);
    if (!event) return;
    const code = Number(event.code ?? 0);
    if (code !== 0) throw mapBusinessError(event as WpsEnvelope);
    const type = cleanString(event.type, 80);
    const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
    if (type === 'convert2pptx_progress') {
      const progress = Math.min(100, Math.max(0, Math.round(Number(data.progress) || 0)));
      if (progress > 0) onProgress?.(progress);
    } else if (type === 'convert2pptx_finish') {
      finish = data;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consume(chunk);
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer.replace(/\r\n/g, '\n'));
  if (!finish) {
    throw new ApiError('WPS_AIPPT_UPSTREAM_ERROR', '可编辑转换服务未返回完成事件。', 502, true);
  }
  return finish;
}

/**
 * 将 image-only PDF 或原 PDF 转成可编辑 PPTX。
 * 注意：cookie 是敏感凭据，任何日志/错误/返回值都不得包含它。
 */
export async function convertPdfWithWpsAippt(
  pdf: Buffer,
  fileName: string,
  deps: WpsAipptDeps = {},
): Promise<WpsAipptResult> {
  if (Date.now() < wpsRateLimitedUntil) {
    throw new ApiError('WPS_AIPPT_RATE_LIMITED', UPSTREAM_BUSY_MESSAGE, 429, true);
  }
  const config = deps.config ?? getGenerationConfig();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { baseUrl, cookie } = requireWpsConfig(config);
  const timeoutMs = Math.max(30_000, deps.timeoutMs ?? config.wpsAipptTimeoutMs ?? CONVERT_TIMEOUT_MS);
  const startedAt = Date.now();
  const safeName = (cleanString(fileName, 180) || 'anppt.pdf').replace(/[^\w.\-]+/g, '_');

  try {
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const token = await requestJson(
      `${baseUrl}/api/ks3/api/ksyun/ks3/token_by_kso`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-client-type': 'wps-web',
          'x-client-version': '0.0.0',
          'x-client-entrance': 'webaippt',
          cookie,
        },
        body: JSON.stringify({
          filename: safeName,
          sha256,
          content_type: 'text/plain',
          method: 'PUT',
          with_rapid: true,
          with_private_url: true,
        }),
      },
      Math.min(timeoutMs, TOKEN_TIMEOUT_MS),
      fetchImpl,
    );

    const data = (token.data || {}) as Record<string, unknown>;
    const request = (data.request || {}) as UploadRequest;
    const objectKey = cleanString(request.object_key ?? data.object_key, 800);
    if (!objectKey) throw new ApiError('WPS_AIPPT_UPSTREAM_ERROR', '可编辑转换服务未返回上传对象。', 502, true);

    if (data.is_file_exist !== true) {
      const objectUrl = cleanString(request.object_url, 3000);
      if (!objectUrl) throw new ApiError('WPS_AIPPT_UPSTREAM_ERROR', '可编辑转换服务未返回上传地址。', 502, true);
      const uploadHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers || {})) {
        if (!key || key.toLowerCase() === 'host' || key.toLowerCase() === 'content-length') continue;
        uploadHeaders[key] = String(value);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const upload = await fetchImpl(objectUrl, {
          method: request.method === 'POST' ? 'POST' : 'PUT',
          headers: uploadHeaders,
          body: new Uint8Array(pdf),
          signal: controller.signal,
        });
        if (!upload.ok) {
          throw new ApiError('WPS_AIPPT_UPLOAD_FAILED', '可编辑转换文件上传失败，请稍后重试。', 502, true);
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw mapNetworkError(error);
      } finally {
        clearTimeout(timer);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/api/structppt/convert_pptx`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'text/plain;charset=UTF-8',
          'x-client-type': 'json2ppt-demo',
          'x-client-version': '0.0.0.0',
          'x-client-entrance': 'json2ppt-banana',
          cookie,
        },
        body: JSON.stringify({
          product_name: 'wps-photo-pc',
          intention_code: 'wps_photo_img2ppt',
          pdf_object_key: objectKey,
          file_name: safeName,
          file_size: pdf.length,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw mapNetworkError(error);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw mapBusinessError({}, response.status);
    deps.onProgress?.(1);
    const finish = await readConversionStream(response, deps.onProgress);
    const fileUrl = cleanString(finish.file_url, 4000);
    if (!fileUrl) throw new ApiError('WPS_AIPPT_UPSTREAM_ERROR', '可编辑转换服务未返回下载地址。', 502, true);

    const downloadController = new AbortController();
    const downloadTimer = setTimeout(() => downloadController.abort(), DOWNLOAD_TIMEOUT_MS);
    let bytes: Buffer;
    try {
      const download = await fetchImpl(fileUrl, { signal: downloadController.signal });
      if (!download.ok) throw new ApiError('WPS_AIPPT_DOWNLOAD_FAILED', '可编辑转换结果下载失败。', 502, true);
      bytes = Buffer.from(await download.arrayBuffer());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw mapNetworkError(error);
    } finally {
      clearTimeout(downloadTimer);
    }
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new ApiError('WPS_AIPPT_DOWNLOAD_FAILED', '可编辑转换结果不是有效 PPTX。', 502, false);
    }

    const durationMs = Date.now() - startedAt;
    recordUpstreamUsage({
      provider: 'wps',
      kind: 'pdf-to-pptx',
      status: 'ok',
      units: 1,
      durationMs,
    });
    return {
      bytes,
      pageCount: Math.max(1, Math.round(finiteNumber(finish.page_count) || 1)),
      durationMs,
      docId: cleanString(finish.doc_id, 120),
      fileName: safeName,
    };
  } catch (error) {
    recordUpstreamUsage({
      provider: 'wps',
      kind: 'pdf-to-pptx',
      status: 'error',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
