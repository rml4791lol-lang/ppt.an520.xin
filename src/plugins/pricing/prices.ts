// 价格表唯一权威：数字与部署覆盖的解析都只在本插件，平台层（lib/server）不存价格。
// 换价 = 换本插件的实现（例如改从 DB / 远程配置读），调用方经 ctx.pricing 自动跟随。
import { actionKeyForAction, type PricingActionKey } from '@/lib/plugin/contracts/pricing';
import type { PricingSource } from '@/lib/plugin/contracts/config';

export type PriceTable = Record<string, number>;

const DEFAULT_SINGLE_PAGE_CREDITS = 10;

const DEFAULT_PRICES: Record<PricingActionKey, number> = {
  'generate.page': 10,
  // 单页改图/微调（图生图，成本低于整页重生成）
  'edit.page': 5,
  outline: 0,
  'export.image': 0,
  'export.editable': 20,
  'export.editable-text': 5,
  'tool.ppt-to-base': 5,
  'generate.single-page': DEFAULT_SINGLE_PAGE_CREDITS,
  'edit.single-page': DEFAULT_SINGLE_PAGE_CREDITS,
};

const SINGLE_PAGE_ACTIONS: PricingActionKey[] = ['generate.single-page', 'edit.single-page'];

/** 与生成链 intFrom 同口径：非正安全整数视为未配置，回落默认值。 */
function positiveIntFrom(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** 解析失败返回 null 走默认表——坏 JSON 不该让整站计价变成 NaN。 */
function parsePricesJson(raw: string): PriceTable | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: PriceTable = {};
    for (const [action, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      out[actionKeyForAction(action) ?? action] = n;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * CREDIT_ACTION_PRICES 是整份覆盖（历史语义）：出现即不再回落默认价，缺项表示该动作未定价。
 * 单页单价有自己的部署旋钮（ANPPT_V2_SINGLE_PAGE_CREDITS），不受整份覆盖影响。
 */
export function loadPriceTable(source: PricingSource): PriceTable {
  const override = parsePricesJson(source.creditActionPrices);
  const table: PriceTable = override ? { ...override } : { ...DEFAULT_PRICES };
  const singlePage = positiveIntFrom(source.singlePageCredits, DEFAULT_SINGLE_PAGE_CREDITS);
  for (const action of SINGLE_PAGE_ACTIONS) table[action] = singlePage;
  return table;
}
