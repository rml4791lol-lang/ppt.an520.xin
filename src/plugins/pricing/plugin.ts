// pricing 先锋插件：价格表的存储、解析与查询都归本插件，平台只认 ctx.pricing。
// 动作 key 契约在平台层 contracts/pricing.ts；部署旋钮经宿主 config 服务取原值（ADR-0001 G4），
// 解析与默认表留在本插件（G1）。
import type { AnPlugin } from '@/lib/plugin/types';
import { PRICING_ACTION_MAP, type PricingService } from '@/lib/plugin/contracts/pricing';
import { HOST_CONFIG_KEY, type HostConfigService } from '@/lib/plugin/contracts/config';
import { loadPriceTable } from './prices';

export type { PricingService } from '@/lib/plugin/contracts/pricing';

export const pricingPlugin: AnPlugin = {
  key: 'pricing',
  version: '0.2.0',
  provides: ['pricing'],
  pricing: Object.keys(PRICING_ACTION_MAP),
  register(ctx) {
    const source = ctx.use<HostConfigService>(HOST_CONFIG_KEY);
    // 调用时现读（env 覆盖与管理端语义同旧实现）；任务内的单价一致由调用方启动快照保证。
    const table = () => loadPriceTable(source.pricingSource());
    const service: PricingService = {
      quote: (actionKey) => table()[actionKey] ?? 0,
      table,
    };
    ctx.register('pricing', service);
  },
};
