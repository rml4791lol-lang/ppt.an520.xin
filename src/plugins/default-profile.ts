// 生产形态配置单：顺序即依赖序。测试可组合替代实现（见 scripts/tests/plugin-runtime.test.mjs）。
import type { AnProfile } from '@/lib/plugin/profile';
import { pricingPlugin } from './pricing/plugin';
import { modelsPlugin } from './models/plugin';
import { pptReplicatePlugin } from './ppt-replicate/plugin';

export const defaultProfile: AnProfile = {
  name: 'default',
  plugins: [pricingPlugin, modelsPlugin, pptReplicatePlugin],
};
