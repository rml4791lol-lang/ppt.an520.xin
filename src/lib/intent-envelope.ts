// 意图信封的共享形状：客户端与服务端同用一份，不含 IO。
// 服务端的 400 适配在 src/lib/server/intents.ts；这里只回答「形状是否合法」。

export type IntentParams = Record<string, unknown>;

/** 参数校验器：返回 false 即拒绝；字段级深校验（扣费/幂等/开关硬门）留在动作里 */
export type IntentParamsValidator = (params: IntentParams) => boolean;

/** (kind → 参数校验器) 表：键就是该契约认的全部 kind，漏登记新 kind 直接编译失败 */
export type IntentParamsTable<M extends Record<string, object>> = {
  [K in keyof M]: IntentParamsValidator;
};

export type ParsedIntent<M extends Record<string, object>> = {
  [K in keyof M]: { kind: K; params: M[K] };
}[keyof M];

/** 边界只校验 params 是对象；具体字段由动作自己验 */
export function acceptParams(): boolean {
  return true;
}

/** 意图形状的唯一解析：{kind,params} → 带类型的意图；不合法返回 null（HTTP 措辞在 server 适配器） */
export function parseIntent<M extends Record<string, object>>(
  value: unknown,
  table: IntentParamsTable<M>,
  expected?: keyof M & string,
): ParsedIntent<M> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { kind?: unknown; params?: unknown };
  if (typeof raw.kind !== 'string' || !Object.prototype.hasOwnProperty.call(table, raw.kind)) {
    return null;
  }
  if (expected !== undefined && raw.kind !== expected) return null;
  const params = raw.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  if (!table[raw.kind as keyof M](params as IntentParams)) return null;
  return { kind: raw.kind, params } as ParsedIntent<M>;
}
