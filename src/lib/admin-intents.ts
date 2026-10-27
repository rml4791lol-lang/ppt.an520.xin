// 后台管理写动作的 typed intent 契约：运行时配置 / 功能开关 / 兑换码 / 连接检查 / 测试用户角色。
// 后台读接口（overview/config/flags/problems/finance）不在此列——读走能力命名，写才需要意图。

export type AdminIntentParams = {
  updateRuntimeConfig: { values?: Record<string, unknown>; clearKeys?: string[] };
  setFeatureFlag: { key: string; state: 'off' | 'beta' | 'public' };
  generateRedemptionCodes: {
    credits: number;
    count?: number;
    batch?: string;
    /** 空串 = 永久有效（沿用旧 body 口径） */
    expiresDays?: number | '' | null;
  };
  checkIntegration: { kind: 'llm' | 'image' | 'editable'; values?: Record<string, unknown> };
  setUserRole: { userId: string; role: 'tester' | 'user' };
};

export type AdminIntentKind = keyof AdminIntentParams;

export type AdminIntent = {
  [K in AdminIntentKind]: { kind: K; params: AdminIntentParams[K] };
}[AdminIntentKind];

export interface AdminActionCall {
  path: string;
  method: 'POST' | 'PUT';
  intent: AdminIntent;
}

const ADMIN_STATIC_PATHS: Record<Exclude<AdminIntentKind, 'setUserRole'>, string> = {
  updateRuntimeConfig: '/api/admin/config',
  setFeatureFlag: '/api/admin/feature-flags',
  generateRedemptionCodes: '/api/admin/redemption-codes',
  checkIntegration: '/api/admin/integrations/check',
};

const ADMIN_METHODS: Record<AdminIntentKind, 'POST' | 'PUT'> = {
  updateRuntimeConfig: 'PUT',
  setFeatureFlag: 'PUT',
  generateRedemptionCodes: 'POST',
  checkIntegration: 'POST',
  setUserRole: 'POST',
};

/** 意图 → 路由：测试用户角色的 id 在路径上，其余是静态管理路由 */
export function toAdminActionCall(intent: AdminIntent): AdminActionCall {
  const method = ADMIN_METHODS[intent.kind];
  if (intent.kind === 'setUserRole') {
    return {
      path: `/api/admin/users/${encodeURIComponent(intent.params.userId)}/role`,
      method,
      intent,
    };
  }
  return { path: ADMIN_STATIC_PATHS[intent.kind], method, intent };
}

function isAdminIntentKind(value: string): value is AdminIntentKind {
  return Object.prototype.hasOwnProperty.call(ADMIN_METHODS, value);
}

/** 线上护栏：只认已知 kind，params 缺省按空对象；参数深校验留在动作自身 */
export function parseAdminIntent(value: unknown): AdminIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { kind?: unknown; params?: unknown };
  if (typeof raw.kind !== 'string' || !isAdminIntentKind(raw.kind)) return null;
  const params = raw.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  return { kind: raw.kind, params } as AdminIntent;
}

/** 路由侧取参数：只接受本条路由声明的 kind，错配返回 null（由服务器适配器转 400） */
export function adminIntentParams<K extends AdminIntentKind>(
  expected: K,
  value: unknown,
): AdminIntentParams[K] | null {
  const intent = parseAdminIntent(value);
  if (!intent || intent.kind !== expected) return null;
  return intent.params as AdminIntentParams[K];
}
