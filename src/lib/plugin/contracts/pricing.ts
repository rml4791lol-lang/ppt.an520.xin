// pricing 契约：插件动作 key 与 env 计费键的映射、服务类型——平台层唯一定义处。
// 插件（src/plugins/pricing）按它注册实现；消费方（credits.ts 等）只依赖本文件与服务键，
// 谁也不 import 谁的实现（docs/PLUGIN-ARCHITECTURE.md §4 冻结清单）。

/** 插件动作 key → env.ts creditActionPrices 键 */
export const PRICING_ACTION_MAP: Record<string, string> = {
  'generate.page': 'deck_page_generate',
  'edit.page': 'deck_page_refine',
  'export.editable': 'export_editable',
  'export.editable-text': 'export_editable_text',
  'export.image': 'export_image',
  outline: 'outline',
  'tool.ppt-to-base': 'ppt_to_base',
};

const ENV_KEY_TO_ACTION: Record<string, string> = Object.fromEntries(
  Object.entries(PRICING_ACTION_MAP).map(([action, envKey]) => [envKey, action]),
);

/** env 计费键 → 插件动作 key；未接入的动作键返回 null（调用方走兼容回退） */
export function actionKeyForEnvKey(envKey: string): string | null {
  return ENV_KEY_TO_ACTION[envKey] ?? null;
}

export interface PricingService {
  /** 未定价动作返回 0：免费是合法形态，不许 throw */
  quote(actionKey: string): number;
  /** 已定价动作表（未定价动作不在表内） */
  table(): Record<string, number>;
}
