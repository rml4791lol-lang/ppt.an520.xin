// 后台管理写动作的 typed intent 契约：运行时配置 / 功能开关 / 兑换码 / 连接检查 / 测试用户角色。
// 后台读接口（overview/config/flags/problems/finance）不在此列——读走能力命名，写才需要意图。
// kind → 解析器回答字段形状与取值范围；配置项是否存在、目标用户是否存在等业务硬门仍在路由/服务层。
import {
  readIntentFields,
  type IntentParamsTable,
} from './intent-envelope';

const FEATURE_STATES = ['off', 'beta', 'public'] as const;
const INTEGRATION_KINDS = ['llm', 'image', 'editable'] as const;
const USER_ROLES = ['tester', 'user'] as const;

export type AdminIntentParams = {
  updateRuntimeConfig: { values?: Record<string, unknown>; clearKeys?: string[] };
  setFeatureFlag: { key: string; state: 'off' | 'beta' | 'public' };
  generateRedemptionCodes: {
    credits: number;
    count?: number;
    batch?: string;
    /** 空串 = 永久有效（沿用旧 body 口径），解析后统一为 null */
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

/**
 * kind → 参数解析器的唯一登记：Record 强制穷尽（新增 kind 忘记登记即编译失败）。
 * 整数范围沿用管理路由既有文案；权限、开关登记、配置白名单、目标账号角色仍由路由/服务层判断。
 */
export const ADMIN_INTENT_PARAMS: IntentParamsTable<AdminIntentParams> = {
  updateRuntimeConfig: (params) => {
    const f = readIntentFields(params);
    const values = f.object('values', 'values 格式不正确');
    const rawClearKeys = f.raw('clearKeys');
    let clearKeys: string[] | undefined;
    if (rawClearKeys != null) {
      if (!Array.isArray(rawClearKeys)) f.fail('clearKeys 格式不正确');
      clearKeys = f.list('clearKeys', 120);
    }
    return f.done({ values, clearKeys });
  },
  setFeatureFlag: (params) => {
    const f = readIntentFields(params);
    const state = f.text('state', 20) as AdminIntentParams['setFeatureFlag']['state'];
    if (!(FEATURE_STATES as readonly string[]).includes(state)) {
      f.fail('开关状态必须是 off/beta/public');
    }
    return f.done({ key: f.text('key', 60), state });
  },
  generateRedemptionCodes: (params) => {
    const f = readIntentFields(params);
    const credits = f.int('credits');
    if (credits === undefined || credits < 1 || credits > 1_000_000) {
      f.fail('每张兑换码积分需为 1–1000000 的整数');
    }
    const count = f.int('count') ?? 1;
    if (count < 1 || count > 100) f.fail('单次生成数量需为 1–100 的整数');
    const rawExpiresDays = f.raw('expiresDays');
    let expiresDays: number | null = null;
    if (rawExpiresDays != null && rawExpiresDays !== '') {
      const parsed = f.int('expiresDays');
      if (parsed !== undefined) {
        if (parsed < 1 || parsed > 3650) f.fail('有效期需为 1–3650 天');
        else expiresDays = parsed;
      }
    }
    return f.done({ credits: credits ?? 0, count, batch: f.text('batch', 64), expiresDays });
  },
  checkIntegration: (params) => {
    const f = readIntentFields(params);
    const kind = f.text('kind', 20) as AdminIntentParams['checkIntegration']['kind'];
    if (!(INTEGRATION_KINDS as readonly string[]).includes(kind)) {
      f.fail('不支持的连接检查类型');
    }
    return f.done({ kind, values: f.object('values', 'values 格式不正确') });
  },
  setUserRole: (params) => {
    const f = readIntentFields(params);
    const role = f.text('role', 20) as AdminIntentParams['setUserRole']['role'];
    if (!(USER_ROLES as readonly string[]).includes(role)) {
      f.fail('role 只能是 tester 或 user');
    }
    return f.done({ userId: f.text('userId', 80), role });
  },
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
