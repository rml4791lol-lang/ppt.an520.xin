import { defineRoute, jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { previewRedemption } from '@/lib/server/redemption';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = defineRoute(async (request) => {
  requireUser(request);
  const body = await readJsonBody(request);
  return jsonOk(previewRedemption(body.code));
}, { mutation: true });
