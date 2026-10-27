// 宿主配置适配器：平台内部配置 → 插件契约。每次调用现读，保留 env 覆盖与
// 管理端运行时覆盖的既有语义（插件服务方法同样是调用时取值）。
import { getEnv } from '@/lib/server/env';
import { getGenerationConfig } from '@/lib/server/generation/config';
import type { HostConfigService } from './contracts/config';

export const hostConfig: HostConfigService = {
  creditActionPrices: () => getEnv().creditActionPrices,
  models() {
    const c = getGenerationConfig();
    return {
      llmModel: c.llmModel,
      llmFallbackModels: c.llmFallbackModels,
      llmBackupModel: c.llmBackupModel,
      imageModel: c.imageModel,
      imageEditModel: c.imageEditModel,
      imageBackupModel: c.imageBackupModel,
      imageBackupEditModel: c.imageBackupEditModel,
    };
  },
};
