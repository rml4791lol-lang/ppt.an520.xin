import { defineRoute, jsonOk, readJsonBody } from '@/lib/server/http';
import { estimateCredits } from '@/lib/server/credits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  const body = await readJsonBody(request);
  return jsonOk(
    estimateCredits({ action: String(body.action ?? ''), pages: Number(body.pages) || undefined }),
  );
}, { mutation: true });
