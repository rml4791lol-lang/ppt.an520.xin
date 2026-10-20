// Uniform API envelope + CSRF/origin guard. Pure web-standard Request/Response,
// no next imports, so scripts/test-backend.mjs can exercise it directly.

import { logProblem } from './problem-log';
import { createRequestContext, getRequestContext, withRequestContext } from './request-context';

export class ApiError extends Error {
  code: string;
  status: number;
  retryable: boolean;

  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function validationError(message: string): ApiError {
  return new ApiError('VALIDATION_ERROR', message, 400, false);
}

export interface ResponseOptions {
  status?: number;
  headers?: Record<string, string>;
}

export function jsonOk<T>(data: T, opts: ResponseOptions = {}): Response {
  return Response.json({ ok: true, data }, { status: opts.status ?? 200, headers: opts.headers });
}

export function jsonError(error: ApiError, headers?: Record<string, string>): Response {
  const finalHeaders = headers ?? (error.status === 429 ? { 'Retry-After': '60' } : undefined);
  const requestId = getRequestContext()?.requestId;
  return Response.json(
    { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, ...(requestId ? { requestId } : {}) } },
    { status: error.status, headers: finalHeaders },
  );
}

export function toErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) return jsonError(error);
  logProblem({ category: 'api', level: 'error', message: '接口未捕获异常', detail: error });
  return jsonError(new ApiError('INTERNAL_ERROR', '服务器开小差了，请稍后重试', 500, true));
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw validationError('请求体不是有效的 JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw validationError('请求体格式不正确');
  }
  return body as Record<string, unknown>;
}

export function getClientIp(request: Request): string {
  // Caddy 只保证 X-Real-IP={remote_host}；XFF 是追加链，首值客户端可伪造，只能作兜底
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

// CSRF guard for mutations: custom header + same-origin Origin when present.
export function guardMutationRequest(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (request.headers.get('x-anppt-action') !== '1') {
    return jsonError(new ApiError('CSRF_REJECTED', '缺少操作确认头，请从页面内发起操作', 403, false));
  }
  const origin = request.headers.get('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      return jsonError(new ApiError('ORIGIN_REJECTED', '请求来源不合法', 403, false));
    }
    const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
      || request.headers.get('host')?.trim()
      || '';
    if (!host || originHost !== host) {
      return jsonError(new ApiError('ORIGIN_REJECTED', '请求来源不合法', 403, false));
    }
  }
  return null;
}

type RouteHandler = (request: Request) => Promise<Response> | Response;

function attachRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-request-id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function defineRoute(handler: RouteHandler, opts: { mutation?: boolean } = {}): RouteHandler {
  return async (request: Request): Promise<Response> => {
    const context = createRequestContext(request);
    const response = await withRequestContext(context, async () => {
      if (opts.mutation) {
        const blocked = guardMutationRequest(request);
        if (blocked) return blocked;
      }
      try {
        return await handler(request);
      } catch (error) {
        return toErrorResponse(error);
      }
    });
    return attachRequestId(response, context.requestId);
  };
}
