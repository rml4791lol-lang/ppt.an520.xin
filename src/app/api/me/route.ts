import { defineRoute, jsonOk } from '@/lib/server/http';
import { requireUser, buildSessionCookie } from '@/lib/server/auth';
import { getBalance } from '@/lib/server/credits';
import { isFeatureVisible } from '@/lib/server/feature-flags';
import { getGenerationConfig } from '@/lib/server/generation/config';
import { hasEverPaid } from '@/lib/server/recharge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute(async (request) => {
  const session = requireUser(request);
  const headers = session.refreshed
    ? { 'Set-Cookie': buildSessionCookie(request, session.token) }
    : undefined;
  const paidOnce = hasEverPaid(session.user.id);
  const features = {
    editableExport: Boolean(getGenerationConfig().codiaApiKey),
    pagedCopyV2: true,
    beautify: isFeatureVisible('ppt_replicate', session.user),
  } as const;
  return jsonOk(
    {
      user: session.user,
      features,
      benefits: { onlyOfficeToolkit: paidOnce, paidOnce },
      balance: getBalance(session.user.id),
    },
    { headers },
  );
});
