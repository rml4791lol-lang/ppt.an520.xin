// models 先锋插件：模型清单 + 回退链的只读包装。权威配置仍在
// generation/config.ts（含管理端运行时覆盖），本插件不改生成链任何行为。
import type { AnPlugin } from '@/lib/plugin/types';
import {
  HOST_CONFIG_KEY,
  type HostConfigService,
  type ModelsConfig,
} from '@/lib/plugin/contracts/config';

export interface ModelsService {
  /** 文本链：主模型 → 回退模型 → 跨站备份（去重） */
  text(): string[];
  /** 图像链：文生图 / 改图 / 跨站灾备（去重、去空） */
  image(): string[];
  /** 沿回退链取下一个模型；链尾或未知模型返回 null */
  fallback(model: string): string | null;
}

function dedupe(models: string[]): string[] {
  return [...new Set(models.filter(Boolean))];
}

function textChain(c: ModelsConfig): string[] {
  return dedupe([c.llmModel, ...c.llmFallbackModels, c.llmBackupModel]);
}

function imageChain(c: ModelsConfig): Array<[string, string]> {
  // 图像回退是按用途成对的（文生图/改图各有自己的灾备模型）
  return [
    [c.imageModel, c.imageBackupModel],
    [c.imageEditModel, c.imageBackupEditModel],
  ];
}

export const modelsPlugin: AnPlugin = {
  key: 'models',
  version: '0.1.0',
  provides: ['models'],
  register(ctx) {
    const config = ctx.use<HostConfigService>(HOST_CONFIG_KEY);
    const service: ModelsService = {
      text: () => textChain(config.models()),
      image: () => dedupe(imageChain(config.models()).flat()),
      fallback(model) {
        const c = config.models();
        const chain = textChain(c);
        const i = chain.indexOf(model);
        if (i >= 0) return chain[i + 1] ?? null;
        for (const [main, backup] of imageChain(c)) {
          if (model === main && backup) return backup;
        }
        return null;
      },
    };
    ctx.register('models', service);
  },
};
