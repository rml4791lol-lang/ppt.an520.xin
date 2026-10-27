// 旧的无类型 body 与 typed intent 共用同一入口：意图信封只解出参数，
// 动作语义（参数深校验/扣费/幂等/开关硬门）仍留在原路由。
import { validationError } from './http';

/**
 * body.intent 存在时必须是本路由声明的 kind（错配/未知一律 400，不静默降级到旧入口）；
 * 没有 intent 时原样返回旧 body——收缩票删掉这条兼容分支。
 */
export function readActionParams<P>(
  body: Record<string, unknown>,
  extract: (intent: unknown) => P | null,
): P {
  if (body.intent === undefined) return body as unknown as P;
  const params = extract(body.intent);
  if (params === null) throw validationError('未知意图');
  return params;
}
