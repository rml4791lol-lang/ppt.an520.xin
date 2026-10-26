// Codia 开放 API 客户端（pdf_to_ppt：image-only PDF → 元素级可编辑 PPTX）。
// 契约（官方文档核实）：
//   上传  POST /v2/open/uploads  multipart 字段 file → {code:0,data:{upload_id}}
//   建任务 POST /v2/open/tasks    {operation:'pdf_to_ppt',input:{upload_id,page_no,title}}
//                                 Header Idempotency-Key（同 key 同输入幂等；不同输入 409）
//   查状态 GET  /v2/open/tasks/{task_id} → data:{status,result:{ppt_url,page_count},error}
// 全部走依赖注入 fetcher（deps.fetchImpl），测试 mock 上游，禁止真实调用付费上游。
import { ApiError } from '@/lib/server/http';
import { getGenerationConfig, type GenerationConfig } from '@/lib/server/generation/config';
import { cleanString } from '@/lib/server/generation/types';
import { recordUpstreamUsage } from '@/lib/server/usage-meter';

export interface CodiaDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
  /** 测试用：覆盖请求自动恢复的退避时间。 */
  retryDelayMs?: number;
}

export interface CodiaTaskView {
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  pptUrl: string;
  pageCount: number;
  /** 上游真实进度百分比（0-100）；未提供时为 0。 */
  progress: number;
  /** 上游已完成页数；未提供时为 0。 */
  completedPages: number;
  /** 上游总页数；未提供时回退 result.page_count。 */
  totalPages: number;
  /** 上游阶段/进度说明；用于前端展示，不参与状态判断。 */
  stage: string;
  error: string;
}

const UPLOAD_TIMEOUT_MS = 480_000;
const REQUEST_TIMEOUT_MS = 90_000;

function requireCodiaConfig(config: GenerationConfig): { baseUrl: string; apiKey: string } {
  if (!config.codiaApiKey) {
    throw new ApiError('EDITABLE_EXPORT_UNAVAILABLE', '可编辑转换服务尚未配置，请联系管理员', 503, false);
  }
  return { baseUrl: config.codiaBaseUrl, apiKey: config.codiaApiKey };
}

interface CodiaEnvelope {
  code?: number;
  message?: string;
  data?: Record<string, unknown>;
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function percentOf(value: unknown): number {
  const number = finiteNumber(value);
  const percent = number > 0 && number <= 1 ? number * 100 : number;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function taskStatusOf(value: unknown): CodiaTaskView['status'] {
  const status = cleanString(value, 40);
  return status === 'processing' || status === 'succeeded' || status === 'failed' || status === 'canceled'
    ? status
    : 'pending';
}

const UPSTREAM_BUSY_MESSAGE = '可编辑转换服务暂时开小差了，系统会继续检查；完成后可在下载中心查看。';

function retryDelay(attempt: number, deps: CodiaDeps): Promise<void> {
  const baseMs = Math.max(0, deps.retryDelayMs ?? 600);
  return new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** attempt));
}

function mapNetworkError(error: unknown): ApiError {
  const timedOut = error instanceof Error && error.name === 'AbortError';
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`[anppt-v2][codia] ${timedOut ? 'request timeout' : 'network error'}: ${cleanString(detail, 500)}`);
  return new ApiError('CODIA_UPSTREAM_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
}

/** HTTP 错误语义：400 请求错（不重试）、401 key 错、402 上游余额不足（不重试）、429/5xx 可重试。 */
function mapHttpError(status: number, payload: CodiaEnvelope, raw: string): ApiError {
  const message = cleanString(payload?.message, 300) || cleanString(raw, 300) || `HTTP ${status}`;
  // 运营可见性：上游原始错误进服务器日志，对外统一走错误码口径
  console.error(`[anppt-v2][codia] HTTP ${status}: ${message}`);
  if (status === 401 || status === 403) {
    return new ApiError('UPSTREAM_AUTH', '可编辑转换服务配置异常，请联系管理员。', 502, false);
  }
  if (status === 402) {
    return new ApiError('UPSTREAM_NO_CREDITS', '可编辑转换服务额度暂时不足，请联系管理员。', 502, false);
  }
  if (status === 429) {
    return new ApiError('CODIA_RATE_LIMITED', UPSTREAM_BUSY_MESSAGE, 429, true);
  }
  if (status >= 500) {
    return new ApiError('CODIA_UPSTREAM_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
  }
  return new ApiError('CODIA_BAD_REQUEST', '可编辑转换请求未被服务接受，请检查文件后重新尝试。', 400, false);
}

async function codiaRequest(
  method: 'GET' | 'POST',
  path: string,
  opts: { json?: unknown; form?: FormData; idempotencyKey?: string; timeoutMs: number },
  deps: CodiaDeps,
): Promise<Record<string, unknown>> {
  const config = deps.config ?? getGenerationConfig();
  const { baseUrl, apiKey } = requireCodiaConfig(config);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  // GET、幂等建任务以及无扣费的上传，在连接抖动/429/5xx 时做短退避自动恢复。
  // 建任务始终复用同一 Idempotency-Key；上传重发最多只产生一个未使用 upload_id，不会创建付费转换任务。
  const maxAttempts = method === 'GET' ? 3 : opts.idempotencyKey || opts.form ? 2 : 1;
  let lastError: ApiError | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: CodiaEnvelope = {};
      try {
        payload = text ? (JSON.parse(text) as CodiaEnvelope) : {};
      } catch {
        console.error(`[anppt-v2][codia] HTTP ${response.status}: non-JSON response`);
        if (!response.ok) throw mapHttpError(response.status, {}, text);
        throw new ApiError('CODIA_UPSTREAM_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
      }
      if (!response.ok) throw mapHttpError(response.status, payload, text);
      if (payload.code !== 0) {
        console.error(`[anppt-v2][codia] envelope code=${payload.code}: ${cleanString(payload.message, 300)}`);
        throw new ApiError('CODIA_UPSTREAM_ERROR', '可编辑转换服务返回异常，请稍后重试。', 502, false);
      }
      return payload.data ?? {};
    } catch (error) {
      lastError = error instanceof ApiError ? error : mapNetworkError(error);
      if (!lastError.retryable || attempt === maxAttempts - 1) throw lastError;
      console.warn(`[anppt-v2][codia] request retry ${attempt + 1}/${maxAttempts - 1}: ${method} ${path}`);
      await retryDelay(attempt, deps);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ApiError('CODIA_UPSTREAM_UNAVAILABLE', UPSTREAM_BUSY_MESSAGE, 502, true);
}

/** 上传 PDF（multipart 字段 file），返回 upload_id */
export async function uploadPdf(pdf: Buffer, filename: string, deps: CodiaDeps = {}): Promise<{ uploadId: string }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
  const data = await codiaRequest('POST', '/v2/open/uploads', { form, timeoutMs: UPLOAD_TIMEOUT_MS }, deps);
  const uploadId = cleanString(data.upload_id, 200);
  if (!uploadId) throw new ApiError('CODIA_UPSTREAM_ERROR', UPSTREAM_BUSY_MESSAGE, 502, true);
  return { uploadId };
}

/** 建 pdf_to_ppt 任务。Idempotency-Key：同 key 同输入幂等返回，不同输入 409 */
export async function createPdfToPptTask(
  input: { uploadId: string; pageNo: number[]; title: string; idempotencyKey: string },
  deps: CodiaDeps = {},
): Promise<{ taskId: string; status: string }> {
  // 计费点记账：建任务即扣上游额度（上传免费、查询免费，见 codiaRequest 注释）
  const startedAt = Date.now();
  try {
    const data = await codiaRequest(
      'POST',
      '/v2/open/tasks',
      {
        json: {
          operation: 'pdf_to_ppt',
          input: { upload_id: input.uploadId, page_no: input.pageNo, title: input.title },
        },
        idempotencyKey: input.idempotencyKey,
        timeoutMs: REQUEST_TIMEOUT_MS,
      },
      deps,
    );
    const taskId = cleanString(data.task_id, 200);
    if (!taskId) throw new ApiError('CODIA_UPSTREAM_ERROR', UPSTREAM_BUSY_MESSAGE, 502, true);
    recordUpstreamUsage({
      provider: 'codia', kind: 'pdf-to-ppt',
      status: 'ok', units: 1, durationMs: Date.now() - startedAt,
    });
    return { taskId, status: cleanString(data.status, 40) || 'pending' };
  } catch (error) {
    recordUpstreamUsage({
      provider: 'codia', kind: 'pdf-to-ppt',
      status: 'error', durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** 查任务状态（官方建议轮询 3-5 秒，由调用方控制节奏） */
export async function getTask(taskId: string, deps: CodiaDeps = {}): Promise<CodiaTaskView> {
  const data = await codiaRequest('GET', `/v2/open/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: REQUEST_TIMEOUT_MS }, deps);
  const result = (data.result ?? {}) as Record<string, unknown>;
  const detail = (data.progress_detail ?? {}) as Record<string, unknown>;
  const completedPages = finiteNumber(
    data.completed_pages ?? detail.completed_pages ?? detail.completed ?? detail.finished_pages,
  );
  const resultPages = finiteNumber(result.page_count);
  const totalPages = finiteNumber(data.total_pages ?? detail.total_pages ?? detail.total ?? resultPages);
  const explicitProgress = percentOf(data.progress ?? detail.progress ?? detail.percentage ?? detail.percent);
  const derivedProgress = totalPages > 0 ? Math.round((completedPages / totalPages) * 100) : 0;
  return {
    status: taskStatusOf(data.status),
    pptUrl: cleanString(result.ppt_url, 1000),
    pageCount: resultPages,
    progress: Math.min(100, Math.max(explicitProgress, derivedProgress)),
    completedPages,
    totalPages,
    stage: cleanString(data.stage ?? detail.stage ?? detail.message ?? detail.description, 200),
    error: cleanString(data.error, 500),
  };
}
