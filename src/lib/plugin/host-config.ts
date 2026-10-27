// 宿主配置适配器：平台内部配置 → 插件契约。每次调用现读，保留 env 覆盖与
// 管理端运行时覆盖的既有语义（插件服务方法同样是调用时取值）。
import { getEffectiveGenerationEnv } from '@/lib/server/admin-config';
import { getGenerationConfig } from '@/lib/server/generation/config';
import type { HostConfigService } from './contracts/config';

function envValue(raw: string | undefined): string {
  return String(raw ?? '').trim();
}

export const hostConfig: HostConfigService = {
  // 价格解析归 pricing 插件（ADR-0001 G1），平台只交原值；与 models 一样走管理端覆盖链，
  // 直读 process.env 会让管理端保存的价格旋钮在下一次读价时看不到。
  pricingSource: () => {
    const env = getEffectiveGenerationEnv();
    return {
      creditActionPrices: envValue(env.CREDIT_ACTION_PRICES),
      singlePageCredits: envValue(env.ANPPT_V2_SINGLE_PAGE_CREDITS),
    };
  },
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
