// Codia 开放 API 客户端（pdf_to_ppt：image-only PDF → 元素级可编辑 PPTX）。
// 契约（官方文档核实）：
//   上传  POST /v2/open/uploads  multipart 字段 file → {code:0,data:{upload_id}}
//   建任务 POST /v2/open/tasks    {operation:'pdf_to_ppt',input:{upload_id,page_no,title}}
//                                 Header Idempotency-Key（同 key 同输入幂等；不同输入 409）
//   查状态 GET  /v2/open/tasks/{task_id} → data:{status,result:{ppt_url,page_count},error}
// 全部走依赖注入 fetcher（deps.fetchImpl），测试 mock 上游，禁止真实调用付费上游。
import { ApiError } from './http';
import { getGenerationConfig, type GenerationConfig } from './generation/config';
import { cleanString } from './generation/types';

export interface CodiaDeps {
  fetchImpl?: typeof fetch;
  config?: GenerationConfig;
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

/** HTTP 错误语义：400 请求错（不重试）、401 key 错、402 上游余额不足（不重试）、429/5xx 可重试 */
function mapHttpError(status: number, payload: CodiaEnvelope, raw: string): ApiError {
  const message = cleanString(payload?.message, 300) || cleanString(raw, 300) || `HTTP ${status}`;
  // 运营可见性：上游原始错误进服务器日志，对外统一走错误码口径
  console.error(`[anppt-v2][codia] HTTP ${status}: ${message}`);
  if (status === 401 || status === 403) {
    return new ApiError('UPSTREAM_AUTH', `Codia 鉴权失败：${message}`, 502, false);
  }
  if (status === 402) {
    return new ApiError('UPSTREAM_NO_CREDITS', `Codia 上游余额不足：${message}`, 502, false);
  }
  if (status === 429) {
    return new ApiError('CODIA_RATE_LIMITED', `Codia 限流：${message}`, 429, true);
  }
  if (status >= 500) {
    return new ApiError('CODIA_UPSTREAM_ERROR', `Codia 服务异常：${message}`, 502, true);
  }
  return new ApiError('CODIA_BAD_REQUEST', `Codia 请求被拒：${message}`, 400, false);
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let payload: CodiaEnvelope = {};
  try {
    payload = text ? (JSON.parse(text) as CodiaEnvelope) : {};
  } catch {
    throw new ApiError('CODIA_UPSTREAM_ERROR', `HTTP ${response.status}: Codia 返回非 JSON`, 502, true);
  }
  if (!response.ok) throw mapHttpError(response.status, payload, text);
  if (payload.code !== 0) {
    console.error(`[anppt-v2][codia] envelope code=${payload.code}: ${cleanString(payload.message, 300)}`);
    throw new ApiError('CODIA_UPSTREAM_ERROR', cleanString(payload.message, 300) || 'Codia 返回业务错误', 502, false);
  }
  return payload.data ?? {};
}

/** 上传 PDF（multipart 字段 file），返回 upload_id */
export async function uploadPdf(pdf: Buffer, filename: string, deps: CodiaDeps = {}): Promise<{ uploadId: string }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
  const data = await codiaRequest('POST', '/v2/open/uploads', { form, timeoutMs: UPLOAD_TIMEOUT_MS }, deps);
  const uploadId = cleanString(data.upload_id, 200);
  if (!uploadId) throw new ApiError('CODIA_UPSTREAM_ERROR', 'Codia 上传未返回 upload_id', 502, true);
  return { uploadId };
}

/** 建 pdf_to_ppt 任务。Idempotency-Key：同 key 同输入幂等返回，不同输入 409 */
export async function createPdfToPptTask(
  input: { uploadId: string; pageNo: number[]; title: string; idempotencyKey: string },
  deps: CodiaDeps = {},
): Promise<{ taskId: string; status: string }> {
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
  if (!taskId) throw new ApiError('CODIA_UPSTREAM_ERROR', 'Codia 建任务未返回 task_id', 502, true);
  return { taskId, status: cleanString(data.status, 40) || 'pending' };
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
