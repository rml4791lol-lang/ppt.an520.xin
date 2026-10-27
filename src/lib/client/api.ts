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

/** typed intent 分发：路径/方法由意图适配器决定，请求体只发 { intent } */
export function dispatchIntent<T>(
  target: { path: string; method: "POST" | "PUT" },
  intent: unknown,
): Promise<T> {
  return apiFetch<T>(target.path, { method: target.method, body: { intent } });
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

/* ---------- 领域客户端（按能力命名；URL/HTTP 方法只留在本文件） ---------- */

export interface ProjectItem {
  id: string;
  projectType: "deck" | "single-page";
  source?: "single" | "replicate";
  title: string;
  status: string;
  pageCount: number;
  coverUrl: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectListResult {
  items: ProjectItem[];
  total: number;
  page: number;
  pageSize: number;
  retentionDays: number;
}

export interface ProjectListQuery {
  projectType?: "deck" | "single-page";
  page?: number;
  pageSize?: number;
}

export interface CreditSummary {
  balance: number;
  totalGranted: number;
  totalSpent: number;
  granted30d: number;
  spent30d: number;
}

export interface CreditLedgerEntry {
  id: string;
  delta: number;
  balanceAfter: number;
  bucket: string;
  reason: string;
  eventType: string;
  refType: string;
  refId: string;
  createdAt: number;
}

export interface CreditLedgerPage {
  items: CreditLedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export type RechargeChannel = "wechat" | "alipay";
export type RechargeOrderStatus = "pending" | "paid" | "expired" | "cancelled";
export type RechargeOrderProvider = "wechat" | "epay" | "mock";

export interface RechargeOrder {
  orderNo: string;
  planId: string;
  amountFen: number;
  credits: number;
  status: RechargeOrderStatus;
  provider: RechargeOrderProvider;
  codeUrl: string;
  checkoutUrl: string;
  createdAt: number;
  paidAt: number | null;
  expiresAt: number;
}

export interface RechargeOrderCreated {
  order: RechargeOrder;
  mock: boolean;
}

export interface RedeemResult {
  credits: number;
  balance: number;
}

export type OnlyOfficeArch = "x64" | "x86" | "arm64";

export interface OnlyOfficeReleaseAsset {
  filename: string;
  size: number;
  sha256: string;
}

export interface OnlyOfficeRelease {
  version: string;
  publishedAt: string;
  assets: Record<OnlyOfficeArch, OnlyOfficeReleaseAsset>;
}

export interface OnlyOfficeBenefit {
  loggedIn: boolean;
  unlocked: boolean;
}

export type AuthResult = { ok: true } | { ok: false; message: string };

function listProjects(query: ProjectListQuery = {}): Promise<ProjectListResult> {
  const params = new URLSearchParams();
  if (query.projectType) params.set("projectType", query.projectType);
  if (query.page) params.set("page", String(query.page));
  if (query.pageSize) params.set("pageSize", String(query.pageSize));
  const qs = params.toString();
  return apiFetch<ProjectListResult>(`/api/projects${qs ? `?${qs}` : ""}`);
}

function removeProject(id: string): Promise<void> {
  return apiFetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }).then(() => undefined);
}

/**
 * 登录页把失败当返回值处理（表单内联报错，不抛异常）。信封错误直接透服务端文案；
 * 非信封响应按 HTTP 状态回退到页面既有文案，网络失败也回退（保留登录页原有口径）。
 */
async function postAuth(path: string, body: unknown): Promise<AuthResult> {
  try {
    await apiFetch(path, { body });
    return { ok: true };
  } catch (error) {
    if (!(error instanceof ApiClientError)) return { ok: false, message: "请求失败，请稍后再试" };
    if (error.code.startsWith("HTTP_") || error.code === "NETWORK_ERROR") {
      return {
        ok: false,
        message: error.status === 404 ? "登录服务尚未接入，敬请期待" : "请求失败，请稍后再试",
      };
    }
    return { ok: false, message: error.message };
  }
}

export const api = {
  projects: {
    list: listProjects,
    remove: removeProject,
  },
  credits: {
    summary: (): Promise<CreditSummary> => apiFetch<CreditSummary>("/api/credits/summary"),
    ledger: (query: { page?: number; pageSize?: number } = {}): Promise<CreditLedgerPage> => {
      const params = new URLSearchParams();
      if (query.page) params.set("page", String(query.page));
      if (query.pageSize) params.set("pageSize", String(query.pageSize));
      const qs = params.toString();
      return apiFetch<CreditLedgerPage>(`/api/credits/ledger${qs ? `?${qs}` : ""}`);
    },
    balance: (): Promise<number | null> =>
      apiFetch<{ balance?: number; available?: number }>("/api/credits/balance").then(
        (data) => data?.balance ?? data?.available ?? null,
      ),
  },
  recharge: {
    createOrder: (input: { planId: string; channel: RechargeChannel }): Promise<RechargeOrderCreated> =>
      apiFetch<RechargeOrderCreated>("/api/recharge/orders", { body: input }),
    getOrder: (orderNo: string): Promise<RechargeOrder> =>
      apiFetch<{ order: RechargeOrder }>(
        `/api/recharge/orders?orderNo=${encodeURIComponent(orderNo)}`,
      ).then((data) => data.order),
    redeem: (code: string): Promise<RedeemResult> =>
      apiFetch<RedeemResult>("/api/points/redemption/redeem", { body: { code } }),
  },
  onlyoffice: {
    benefit: async (): Promise<OnlyOfficeBenefit> => {
      const session = await getSession().catch(() => ({ authenticated: false, user: null }));
      if (!session.authenticated) return { loggedIn: false, unlocked: false };
      try {
        const me = await apiFetch<{ benefits?: { onlyOfficeToolkit?: boolean } }>("/api/me");
        return { loggedIn: true, unlocked: Boolean(me?.benefits?.onlyOfficeToolkit) };
      } catch {
        return { loggedIn: false, unlocked: false };
      }
    },
    getRelease: (): Promise<OnlyOfficeRelease> =>
      apiFetch<OnlyOfficeRelease>("/api/tools/onlyoffice/release"),
    downloadHref: (arch: OnlyOfficeArch): string => `/api/tools/onlyoffice/download/${arch}`,
  },
  auth: {
    requestOtp: (identifier: string): Promise<AuthResult> =>
      postAuth("/api/auth/otp/request", { identifier }),
    loginWithOtp: (input: { identifier: string; code: string }): Promise<AuthResult> =>
      postAuth("/api/auth/otp/verify", input),
    loginWithPassword: (input: { account: string; password: string }): Promise<AuthResult> =>
      postAuth("/api/auth/login", input),
    register: (input: {
      account: string;
      email: string;
      password: string;
      confirmPassword: string;
    }): Promise<AuthResult> => postAuth("/api/auth/register", input),
  },
};

