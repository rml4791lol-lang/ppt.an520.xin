// pricing 先锋插件：价格表的存储、解析与查询都归本插件，平台只认 ctx.pricing。
// 动作 key 契约（PRICING_ACTION_MAP / PricingService）在平台层 src/lib/plugin/contracts/pricing.ts。
import type { AnPlugin } from '@/lib/plugin/types';
import { PRICING_ACTION_MAP, type PricingService } from '@/lib/plugin/contracts/pricing';
import { loadPriceTable } from './prices';

export type { PricingService } from '@/lib/plugin/contracts/pricing';

export const pricingPlugin: AnPlugin = {
  key: 'pricing',
  version: '0.2.0',
  provides: ['pricing'],
  pricing: Object.keys(PRICING_ACTION_MAP),
  register(ctx) {
    // 装配期定格：读价走内存表，不在每次 quote 时重解析 env；任务内的单价一致由调用方启动快照保证。
    const table = loadPriceTable();
    const service: PricingService = {
      quote: (actionKey) => table[actionKey] ?? 0,
      table: () => ({ ...table }),
    };
    ctx.register('pricing', service);
  },
};
