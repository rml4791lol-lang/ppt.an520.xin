// 服务注册表：fail fast 是刻意的——未注册的键在启动期报错，不许运行期 undefined 漂移。
import type { PluginRegistry } from './types';

export interface PluginCtx extends PluginRegistry {
  keys(): string[];
  /** 清空注册表（测试用） */
  reset(): void;
}

export function createCtx(): PluginCtx {
  const services = new Map<string, unknown>();
  const list = () => [...services.keys()].join(', ') || '(空)';
  return {
    register(key, impl) {
      if (services.has(key)) {
        throw new Error(`插件服务键冲突："${key}" 已注册（现有键：${list()}）`);
      }
      services.set(key, impl);
    },
    use<T = unknown>(key: string): T {
      if (!services.has(key)) {
        throw new Error(`插件服务未注册："${key}"（已注册键：${list()}）`);
      }
      return services.get(key) as T;
    },
    has: (key) => services.has(key),
    keys: () => [...services.keys()],
    reset: () => services.clear(),
  };
}
