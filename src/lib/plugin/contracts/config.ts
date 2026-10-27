// 插件配置契约：平台把 env / 生成链配置收窄成只读服务，boot 时注入 ctx。
// 插件只依赖本契约，不 import @/lib/server（ADR-0001 G4；eslint zone 强制）。

/** 生成链模型字段的只读视图（models 插件只需要这些） */
export interface ModelsConfig {
  llmModel: string;
  llmFallbackModels: string[];
  llmBackupModel: string;
  imageModel: string;
  imageEditModel: string;
  imageBackupModel: string;
  imageBackupEditModel: string;
}

export interface HostConfigService {
  /** env.ts 计费键 → 单价（🌟），CREDIT_ACTION_PRICES 覆盖生效 */
  creditActionPrices(): Record<string, number>;
  /** 生成链模型清单（含管理端运行时覆盖） */
  models(): ModelsConfig;
}

export const HOST_CONFIG_KEY = 'config';
