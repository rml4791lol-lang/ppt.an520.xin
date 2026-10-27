// 配置单：一个运行中的实例 = 一张有序插件清单（顺序即依赖序）。
import type { AnPlugin, PluginRegistry } from './types';
import { createCtx, type PluginCtx } from './ctx';

export interface AnProfile {
  name: string;
  plugins: AnPlugin[];
}

/** 装配清单：启动日志与 /api/health 共用的可审计快照。 */
export interface PluginManifest {
  profile: string;
  assembledAt: string;
  plugins: Array<{ key: string; version: string; provides: string[] }>;
  services: string[];
}

export interface AssembledProfile {
  ctx: PluginCtx;
  manifest: PluginManifest;
}

/** 宿主在插件注册前注入的服务（如 config）；插件经 ctx.use 取用，缺失即启动期失败。 */
export type HostServices = Record<string, unknown>;

function registerHost(ctx: PluginCtx, host?: HostServices): void {
  for (const [key, impl] of Object.entries(host ?? {})) ctx.register(key, impl);
}

export async function boot(profile: AnProfile, host?: HostServices): Promise<PluginCtx> {
  const ctx = createCtx();
  registerHost(ctx, host);
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
export function bootSync(profile: AnProfile, host?: HostServices): PluginCtx {
  const ctx = createCtx();
  registerHost(ctx, host);
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

/**
 * 启动期装配 = boot + 服务键验收 + 装配清单。
 * requiredServices 由组合根传入：profile 格式冻结，平台要消费哪些键是平台的知识。
 */
export function assembleSync(
  profile: AnProfile,
  host?: HostServices,
  requiredServices: readonly string[] = [],
): AssembledProfile {
  const ctx = bootSync(profile, host);
  for (const key of requiredServices) {
    if (!ctx.has(key)) {
      const registered = ctx.keys().join(', ') || '(空)';
      throw new Error(`启动期装配失败：profile "${profile.name}" 缺少服务键 "${key}"（已注册：${registered}）`);
    }
  }
  return {
    ctx,
    manifest: {
      profile: profile.name,
      assembledAt: new Date().toISOString(),
      plugins: profile.plugins.map(({ key, version, provides }) => ({
        key,
        version,
        provides: [...provides],
      })),
      services: ctx.keys(),
    },
  };
}
