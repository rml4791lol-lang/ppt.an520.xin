import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { quoteExport } from '@/lib/server/exports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 导出报价：{deckId} / {projectId} / {pageIds|pageId|versionId} */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = await readJsonBody(request);
  return jsonOk(quoteExport(user.id, body));
}, { mutation: true });
