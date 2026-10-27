// 意图信封的唯一解包点：只接受 {intent:{kind,params}}。
// 旧的无类型 body 直通分支已删除——动作名不再是线上词汇（见 docs/DEBUG-HANDBOOK.md §30）。
import { validationError } from './http';

/**
 * intent 必须是本路由声明的 kind：缺信封 / 未知 kind / kind 错配一律 400，不静默降级。
 * 参数深校验（扣费/幂等/开关硬门）仍留在原路由。
 */
export function readIntentParams<P>(body: unknown, extract: (intent: unknown) => P | null): P {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('intent' in body)) {
    throw validationError('缺少意图');
  }
  const params = extract((body as { intent: unknown }).intent);
  if (params === null) throw validationError('未知意图');
  return params;
}
