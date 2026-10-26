// pricing 先锋插件：价格表收拢为服务。数字唯一权威仍是 env.ts 的
// DEFAULT_ACTION_PRICES / CREDIT_ACTION_PRICES 覆盖链，本插件只做动作 key 映射，不抄数字。
// 动作 key 契约（PRICING_ACTION_MAP / PricingService）在平台层 src/lib/plugin/contracts/pricing.ts。
import { getEnv } from '@/lib/server/env';
import type { AnPlugin } from '@/lib/plugin/types';
import {
  PRICING_ACTION_MAP,
  type PricingService,
} from '@/lib/plugin/contracts/pricing';

export type { PricingService } from '@/lib/plugin/contracts/pricing';

function buildTable(): Record<string, number> {
  const prices = getEnv().creditActionPrices;
  const table: Record<string, number> = {};
  for (const [actionKey, envKey] of Object.entries(PRICING_ACTION_MAP)) {
    if (envKey in prices) table[actionKey] = prices[envKey];
  }
  return table;
}

const service: PricingService = {
  quote: (actionKey) => buildTable()[actionKey] ?? 0,
  table: buildTable,
};

export const pricingPlugin: AnPlugin = {
  key: 'pricing',
  version: '0.1.0',
  provides: ['pricing'],
  pricing: Object.keys(PRICING_ACTION_MAP),
  register(ctx) {
    ctx.register('pricing', service);
  },
};
