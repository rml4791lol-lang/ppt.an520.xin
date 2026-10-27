// pricing 契约：计费动作 key 清单与服务类型——平台层唯一定义处。
// 插件（src/plugins/pricing）按它注册实现；消费方（credits.ts 等）只依赖本文件与服务键，
// 谁也不 import 谁的实现（docs/PLUGIN-ARCHITECTURE.md §4 冻结清单）。

/** 插件动作 key → 平台公开动作键（客户端 /api/credits/estimate 与部署覆盖用的同一套键） */
export const PRICING_ACTION_MAP: Record<string, string> = {
  'generate.page': 'deck_page_generate',
  'edit.page': 'deck_page_refine',
  'export.editable': 'export_editable',
  'export.editable-text': 'export_editable_text',
  'export.image': 'export_image',
  outline: 'outline',
  'tool.ppt-to-base': 'ppt_to_base',
  'generate.single-page': 'single_page_generate',
  'edit.single-page': 'single_page_refine',
};

const ACTION_TO_ACTION_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(PRICING_ACTION_MAP).map(([actionKey, action]) => [action, actionKey]),
);

/** 公开动作键 → 插件动作 key；未接入的动作键返回 null（调用方按未知动作拒绝） */
export function actionKeyForAction(action: string): string | null {
  return ACTION_TO_ACTION_KEY[action] ?? null;
}

export interface PricingService {
  /** 未定价动作返回 0：免费是合法形态，不许 throw */
  quote(actionKey: string): number;
  /** 已定价动作表（未定价动作不在表内） */
  table(): Record<string, number>;
}
