// 浏览器端统一 API 封装。
// 响应信封：{ ok: true, data } / { ok: false, error: { code, message, retryable } }
// 写操作（POST/PATCH/DELETE）自动带 x-anppt-action: 1（服务端 CSRF 确认头，
// 见 src/lib/server/http.ts 的 guardMutationRequest）。

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable?: boolean;
}

export class ApiClientError extends Error {
  code: string;
  status: number;
  retryable: boolean;

  constructor(code: string, message: string, status = 0, retryable = false) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === "UNAUTHORIZED";
  }

  get isInsufficientCredits(): boolean {
    return this.status === 402 || this.code === "INSUFFICIENT_CREDITS";
  }
}

interface ApiFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON body（与 formData 二选一） */
  body?: unknown;
  /** multipart 表单（与 body 二选一） */
  formData?: FormData;
  /** 网络层失败时的兜底文案 */
  networkErrorMessage?: string;
}

/**
 * 请求并解包信封。失败一律抛 ApiClientError：
 * - 401 → code=UNAUTHORIZED（调用方决定跳登录）
 * - 402 / INSUFFICIENT_CREDITS → isInsufficientCredits === true
 */
export async function apiFetch<T>(path: string, opts: ApiFetchOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.formData ? "POST" : "GET");
  const isMutation = method !== "GET";

  const headers: Record<string, string> = {};
  if (isMutation) headers["x-anppt-action"] = "1";
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new ApiClientError(
      "NETWORK_ERROR",
      opts.networkErrorMessage ?? "网络连接异常，请检查网络后重试",
      0,
      true,
    );
  }

  let json: { ok?: boolean; data?: unknown; error?: ApiErrorBody } | null;
  try {
    json = (await res.json()) as { ok?: boolean; data?: unknown; error?: ApiErrorBody };
  } catch {
    json = null;
  }

  if (!res.ok || !json || json.ok !== true) {
    const err = json?.error;
    throw new ApiClientError(
      err?.code || (res.status === 401 ? "UNAUTHORIZED" : `HTTP_${res.status}`),
      err?.message || (res.status === 401 ? "请先登录后再操作" : `请求失败（${res.status}）`),
      res.status,
      err?.retryable ?? res.status >= 500,
    );
  }
  return json.data as T;
}

export interface SessionInfo {
  authenticated: boolean;
  user: { id: string; username: string } | null;
}

let sessionPromise: Promise<SessionInfo> | null = null;

/**
 * 当前会话。同一页面生命周期内只请求一次 —— 壳、导出中心、项目列表、单页工作台、
 * onlyoffice、可编辑转换各取一次会话时，原本会打出 6 次 /api/auth/session。
 * 登录/登出后调用 resetSessionCache()，否则会读到旧会话。
 */
export function getSession(): Promise<SessionInfo> {
  if (!sessionPromise) {
    sessionPromise = apiFetch<{ authenticated?: boolean; user?: { id: string; username: string } | null }>(
      "/api/auth/session",
    ).then(
      (data) => ({ authenticated: Boolean(data?.authenticated), user: data?.user ?? null }),
      (error) => {
        sessionPromise = null;
        throw error;
      },
    );
  }
  return sessionPromise;
}

/** 登录/登出后清掉会话缓存。 */
export function resetSessionCache(): void {
  sessionPromise = null;
}
