// 配置单：一个运行中的实例 = 一张有序插件清单（顺序即依赖序）。
import type { AnPlugin, PluginRegistry } from './types';
import { createCtx, type PluginCtx } from './ctx';

export interface AnProfile {
  name: string;
  plugins: AnPlugin[];
}

export async function boot(profile: AnProfile): Promise<PluginCtx> {
  const ctx = createCtx();
  const seen = new Set<string>();
  for (const plugin of profile.plugins) {
    if (seen.has(plugin.key)) {
      throw new Error(`profile "${profile.name}" 插件键重复：${plugin.key}`);
    }
    seen.add(plugin.key);
    await plugin.register(ctx as PluginRegistry);
  }
  return ctx;
}

/** 同步启动：仅当所有插件 register 同步返回；出现异步 register 立即报错（fail fast）。 */
export function bootSync(profile: AnProfile): PluginCtx {
  const ctx = createCtx();
  const seen = new Set<string>();
  for (const plugin of profile.plugins) {
    if (seen.has(plugin.key)) {
      throw new Error(`profile "${profile.name}" 插件键重复：${plugin.key}`);
    }
    seen.add(plugin.key);
    const result = plugin.register(ctx as PluginRegistry) as unknown;
    if (result && typeof (result as Promise<void>).then === 'function') {
      throw new Error(`profile "${profile.name}" 插件 "${plugin.key}" 的 register 是异步的，bootSync 只接受同步插件`);
    }
  }
  return ctx;
}
