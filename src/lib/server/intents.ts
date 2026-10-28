// 意图信封的唯一解包点：只接受 {intent:{kind,params}}。
// 旧的无类型 body 直通分支已删除——动作名不再是线上词汇（见 docs/DEBUG-HANDBOOK.md §30）。
import { parseIntent, type IntentParamsTable, type ParsedIntent } from '../intent-envelope';
import { validationError } from './http';

/**
 * intent 必须是本路由声明的 kind：缺信封 / 未知 kind / kind 错配一律 400，不静默降级。
 * 第二参是 (kind → 参数校验器) 表：单 kind 路由传 expected 收紧，deck 一次收整张表。
 * 参数深校验（扣费/幂等/开关硬门）仍留在原路由。
 */
export function readIntentParams<M extends Record<string, object>>(
  body: unknown,
  table: IntentParamsTable<M>,
): ParsedIntent<M>;
export function readIntentParams<M extends Record<string, object>, K extends keyof M & string>(
  body: unknown,
  table: IntentParamsTable<M>,
  expected: K,
): Extract<ParsedIntent<M>, { kind: K }>;
export function readIntentParams<M extends Record<string, object>>(
  body: unknown,
  table: IntentParamsTable<M>,
  expected?: keyof M & string,
): ParsedIntent<M> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('intent' in body)) {
    throw validationError('缺少意图');
  }
  const intent = parseIntent((body as { intent: unknown }).intent, table, expected);
  if (!intent) throw validationError('未知意图');
  return intent;
}
