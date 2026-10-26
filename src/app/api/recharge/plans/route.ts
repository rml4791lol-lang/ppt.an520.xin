import { defineRoute, jsonOk } from '@/lib/server/http';
import { listRechargePlans } from '@/lib/server/recharge';
import { getEnv } from '@/lib/server/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async () => {
  const env = getEnv();
  return jsonOk({
    plans: listRechargePlans().map((plan) => ({
      id: plan.id,
      label: plan.label,
      amountFen: plan.amountFen,
      priceYuan: (plan.amountFen / 100).toFixed(2),
      credits: plan.credits,
      featured: Boolean(plan.featured),
      description: plan.description || '',
    })),
    channels: {
      wechat: env.wechat.enabled || env.wechat.mock,
      alipay: env.epay.enabled || env.epay.mock,
    },
  });
});
