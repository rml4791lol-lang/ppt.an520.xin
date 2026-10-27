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

/**
 * 价格部署旋钮的原始值：默认表、覆盖解析与单页单价都归 pricing 插件
 * （ADR-0001 G1——平台层不存价格，也不解析价格），这里只交字符串原值。
 */
export interface PricingSource {
  /** CREDIT_ACTION_PRICES 原始 JSON；空 = 用插件默认表 */
  creditActionPrices: string;
  /** ANPPT_V2_SINGLE_PAGE_CREDITS 原始值；空 = 用插件默认值 */
  singlePageCredits: string;
}

export interface HostConfigService {
  pricingSource(): PricingSource;
  /** 生成链模型清单（含管理端运行时覆盖） */
  models(): ModelsConfig;
}

export const HOST_CONFIG_KEY = 'config';
