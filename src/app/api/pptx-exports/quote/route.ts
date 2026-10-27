import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute } from '@/lib/server/generation/route';
import { quoteExport } from '@/modules/editable-export/server/editable';
import { exportIntentParams } from '@/lib/export-intents';
import { readIntentParams } from '@/lib/server/intents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 导出报价：{deckId} / {projectId} / {pageIds|pageId|versionId} */
export const POST = defineApiRoute(async (request) => {
  const { user } = requireUser(request);
  const body = readIntentParams(await readJsonBody(request), (intent) => exportIntentParams('quoteExport', intent));
  return jsonOk(quoteExport(user.id, body));
}, { mutation: true });
