// 意图信封的共享形状：客户端与服务端同用一份，不含 IO。
// 服务端的 400 适配在 src/lib/server/intents.ts；这里只回答「形状是否合法」。
// kind → 解析器回答「什么 payload 合法」：类型、字符串上限、布尔归一、数组清洗都在解析器里；
// 计费/幂等/权限/开关等业务硬门不进这里（仍由动作决定）。

export type IntentParams = Record<string, unknown>;

/** 单 kind 的参数解析结果：失败只带用户可读文案，HTTP 状态由 server 适配器统一套 400 */
export type IntentParamsParse<P> = { ok: true; params: P } | { ok: false; message: string };

export type IntentParamsParser<P> = (params: IntentParams) => IntentParamsParse<P>;

/** (kind → 参数解析器) 表：键就是该契约认的全部 kind，漏登记新 kind 直接编译失败 */
export type IntentParamsTable<M extends Record<string, object>> = {
  [K in keyof M]: IntentParamsParser<M[K]>;
};

export type ParsedIntent<M extends Record<string, object>> = {
  [K in keyof M]: { kind: K; params: M[K] };
}[keyof M];

/** 信封解析结果：成功即类型化意图（ok 可判别），失败带文案 */
export type IntentParseResult<M extends Record<string, object>> =
  | ({ ok: true } & ParsedIntent<M>)
  | { ok: false; message: string };

/** 尚未迁移解析器的契约占位：原样收下参数（三表迁移票完成后删除） */
export function acceptParams<P extends object>(params: IntentParams): IntentParamsParse<P> {
  return { ok: true, params: params as P };
}

/**
 * 逐字段读取器：类型不对/超限时记下第一条错误，解析器末尾用 done 一次收口。
 * record() 返回同一条错误链上的嵌套读取器（新页草稿这类子对象）。
 */
export interface IntentFieldReader {
  has(key: string): boolean;
  raw(key: string): unknown;
  text(key: string, max: number): string;
  flag(key: string): boolean | undefined;
  int(key: string): number | undefined;
  list(key: string, maxItem: number, maxItems?: number): string[];
  record(key: string): IntentFieldReader | undefined;
  fail(message: string): void;
  done<P>(params: P): IntentParamsParse<P>;
}

export function readIntentFields(params: IntentParams): IntentFieldReader {
  // 解析器是纯函数：信封已挡掉非对象，这里再兜一次直调，坏输入降级为空对象而不是抛异常
  const source = params && typeof params === 'object' ? params : {};
  return makeFieldReader(source, { error: '' });
}

function makeFieldReader(params: IntentParams, state: { error: string }): IntentFieldReader {
  const fail = (message: string): void => {
    if (!state.error) state.error = message;
  };
  return {
    has: (key) => Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined,
    raw: (key) => params[key],
    text(key, max) {
      const value = params[key];
      if (value === undefined || value === null) return '';
      if (typeof value !== 'string') {
        fail(`${key} 必须是字符串`);
        return '';
      }
      return value.trim().slice(0, max);
    },
    flag(key) {
      const value = params[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === '1') return true;
      if (value === 0 || value === '0') return false;
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
      }
      fail(`${key} 必须是布尔值`);
      return undefined;
    },
    int(key) {
      const value = params[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        fail(`${key} 必须是整数`);
        return undefined;
      }
      return value;
    },
    list(key, maxItem, maxItems = 500) {
      const value = params[key];
      if (!Array.isArray(value)) {
        fail(`${key} 必须是数组`);
        return [];
      }
      const items: string[] = [];
      for (const item of value) {
        if (typeof item !== 'string') {
          fail(`${key} 必须是字符串数组`);
          continue;
        }
        const text = item.trim().slice(0, maxItem);
        if (text) items.push(text);
      }
      return items.slice(0, maxItems);
    },
    record(key) {
      const value = params[key];
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'object' || Array.isArray(value)) {
        fail(`${key} 必须是对象`);
        return undefined;
      }
      return makeFieldReader(value as IntentParams, state);
    },
    fail,
    done<P>(value: P): IntentParamsParse<P> {
      return state.error ? { ok: false, message: state.error } : { ok: true, params: value };
    },
  };
}

/** 意图形状的唯一解析：{kind,params} → 类型化意图；失败带文案（HTTP 措辞在 server 适配器） */
export function parseIntent<M extends Record<string, object>>(
  value: unknown,
  table: IntentParamsTable<M>,
  expected?: keyof M & string,
): IntentParseResult<M> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: '未知意图' };
  }
  const raw = value as { kind?: unknown; params?: unknown };
  if (typeof raw.kind !== 'string' || !Object.prototype.hasOwnProperty.call(table, raw.kind)) {
    return { ok: false, message: '未知意图' };
  }
  if (expected !== undefined && raw.kind !== expected) return { ok: false, message: '未知意图' };
  const params = raw.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, message: '参数格式不正确' };
  }
  const parser = table[raw.kind as keyof M] as IntentParamsParser<M[keyof M]>;
  const parsed = parser(params as IntentParams);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, kind: raw.kind, params: parsed.params } as IntentParseResult<M>;
}
