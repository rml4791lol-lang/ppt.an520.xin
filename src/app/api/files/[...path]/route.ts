import { jsonOk } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute, paramsOf } from '@/lib/server/generation/route';
import { mimeForPath, readResolvedFile, resolveFilePath } from '@/lib/server/generation/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const segments = await paramsOf(ctx, 'path');
  const { absPath } = resolveFilePath(segments, user.id);
  const { data, size } = await readResolvedFile(absPath);
  const mime = mimeForPath(absPath);
  const download = new URL(request.url).searchParams.get('download') === '1';
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
  };
  if (download || mime.includes('presentationml')) {
    headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(segments[segments.length - 1] || 'download')}"`;
  }
  return new Response(new Uint8Array(data), { status: 200, headers });
});
