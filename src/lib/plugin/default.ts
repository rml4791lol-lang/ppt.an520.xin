// 生产默认服务上下文：启动期同步装配 defaultProfile，全进程共享一份。
// 计价/模型等高频同步读点（如 credits.estimateCredits）从这里取服务，不走 async boot。
import type { PluginCtx } from './ctx';
import { assembleSync, type PluginManifest } from './profile';
import { HOST_CONFIG_KEY } from './contracts/config';
import { hostConfig } from './host-config';
import { defaultProfile } from '@/plugins/default-profile';

/** 平台在请求期消费的服务键：启动期少一个就炸，不留到首个计价请求。 */
export const REQUIRED_SERVICE_KEYS = ['pricing'] as const;

interface ProcessAssembly {
  ctx: PluginCtx;
  manifest: PluginManifest;
}

// instrumentation 与路由是两套 webpack 入口，模块级缓存各有一份；装配结果必须挂进程级，
// 否则首个请求会再装配一次、健康检查也读不到启动期的清单。
const globalRef = globalThis as typeof globalThis & { __anpptV2PluginAssembly?: ProcessAssembly };

// ctx → 装配清单：setDefaultCtx 换替身再换回原 ctx 时能恢复准确清单（测试进程内有效）。
const manifestByCtx = new WeakMap<PluginCtx, PluginManifest>();

function assembleOnce(): ProcessAssembly {
  const existing = globalRef.__anpptV2PluginAssembly;
  if (existing) {
    manifestByCtx.set(existing.ctx, existing.manifest);
    return existing;
  }
  const assembled = assembleSync(defaultProfile, { [HOST_CONFIG_KEY]: hostConfig }, REQUIRED_SERVICE_KEYS);
  const processAssembly = { ctx: assembled.ctx, manifest: assembled.manifest };
  globalRef.__anpptV2PluginAssembly = processAssembly;
  manifestByCtx.set(processAssembly.ctx, processAssembly.manifest);
  const plugins = processAssembly.manifest.plugins.map(({ key, version }) => `${key}@${version}`).join(' + ');
  console.log(
    `[anppt-v2][plugin] 启动期装配 profile "${processAssembly.manifest.profile}"：${plugins}`
    + `（服务键：${processAssembly.manifest.services.join(', ')}）`,
  );
  return processAssembly;
}

/** 启动钩子（src/instrumentation.ts）调用：装配、打日志、返回清单；重复调用返回同一份。 */
export function startDefaultPlugins(): PluginManifest {
  return assembleOnce().manifest;
}

export function getDefaultCtx(): PluginCtx {
  return assembleOnce().ctx;
}

/** 没有 profile 元数据的替换上下文：插件版本无从得知，只能如实标记运行期替换。 */
function manifestForReplacedCtx(ctx: PluginCtx): PluginManifest {
  return {
    profile: 'runtime-replaced',
    assembledAt: new Date().toISOString(),
    plugins: [],
    services: ctx.keys(),
  };
}

/**
 * 换实现接缝（ADR-0001 G1）：测试/嵌入可整体替换默认上下文；null 复位，下次访问重新装配。
 * 清单必须跟着 ctx 换：沿用旧清单会让 /api/health.plugins 把已被替换掉的实现版本当成现役。
 */
export function setDefaultCtx(ctx: PluginCtx | null): void {
  if (!ctx) {
    delete globalRef.__anpptV2PluginAssembly;
    return;
  }
  globalRef.__anpptV2PluginAssembly = {
    ctx,
    manifest: manifestByCtx.get(ctx) ?? manifestForReplacedCtx(ctx),
  };
}

/** 健康检查读当前装配清单；生产进程启动钩子已装配，这里只兜底未装配的入口。 */
export function getPluginManifest(): PluginManifest {
  return assembleOnce().manifest;
}
