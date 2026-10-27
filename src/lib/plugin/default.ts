// 生产默认服务上下文：懒同步启动 defaultProfile，全进程共享一份。
// 计价/模型等高频同步读点（如 credits.estimateCredits）从这里取服务，不走 async boot。
import type { PluginCtx } from './ctx';
import { bootSync } from './profile';
import { defaultProfile } from '@/plugins/default-profile';

let cached: PluginCtx | null = null;

export function getDefaultCtx(): PluginCtx {
  if (!cached) cached = bootSync(defaultProfile);
  return cached;
}

/** 换实现接缝：测试/嵌入可整体替换默认上下文（生产只在懒启动时装配一次）；null 复位。 */
export function setDefaultCtx(ctx: PluginCtx | null): void {
  cached = ctx;
}
