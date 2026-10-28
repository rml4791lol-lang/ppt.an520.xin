// 后台管理写动作的 typed intent 契约：运行时配置 / 功能开关 / 兑换码 / 连接检查 / 测试用户角色。
// 后台读接口（overview/config/flags/problems/finance）不在此列——读走能力命名，写才需要意图。
import { acceptParams, type IntentParamsTable } from './intent-envelope';

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

/** kind → 参数校验器的唯一登记：服务端 readIntentParams 用这张表判本契约的 kind */
export const ADMIN_INTENT_PARAMS: IntentParamsTable<AdminIntentParams> = {
  updateRuntimeConfig: acceptParams,
  setFeatureFlag: acceptParams,
  generateRedemptionCodes: acceptParams,
  checkIntegration: acceptParams,
  setUserRole: acceptParams,
};

/** 意图 → 路由：测试用户角色的 id 在路径上，其余是静态管理路由 */
export function toAdminActionCall(intent: AdminIntent): AdminActionCall {
  const method = ADMIN_METHODS[intent.kind];
  if (intent.kind === 'setUserRole') {
    return {
      path: `/api/admin/users/${encodeURIComponent(intent.params.userId)}/role`,
      method,
    };
  }
  return { path: ADMIN_STATIC_PATHS[intent.kind], method };
}
