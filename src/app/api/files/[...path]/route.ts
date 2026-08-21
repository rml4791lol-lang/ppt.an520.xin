import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { requireUser } from '@/lib/server/auth';
import { ApiError } from '@/lib/server/http';
import { defineApiRoute, paramsOf, type ApiRouteContext } from '@/lib/server/generation/route';
import { mimeForPath, resolveFilePath } from '@/lib/server/generation/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ByteRange {
  start: number;
  end: number;
}

function parseRange(header: string | null, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  if (!header.startsWith('bytes=') || header.includes(',')) return 'invalid';
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const rawStart = match[1];
  const rawEnd = match[2];
  if (!rawStart && !rawEnd) return 'invalid';
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return 'invalid';
  }
  return { start, end: Math.min(end, size - 1) };
}

async function serveFile(request: Request, ctx: ApiRouteContext, headOnly: boolean): Promise<Response> {
  const { user } = requireUser(request);
  const segments = await paramsOf(ctx, 'path');
  const { absPath } = resolveFilePath(segments, user.id);
  let info;
  try {
    info = await stat(absPath);
  } catch {
    throw new ApiError('FILE_NOT_FOUND', '文件不存在', 404, false);
  }
  if (!info.isFile()) throw new ApiError('FILE_NOT_FOUND', '文件不存在', 404, false);

  const size = info.size;
  const mime = mimeForPath(absPath);
  const download = new URL(request.url).searchParams.get('download') === '1';
  const filename = segments[segments.length - 1] || 'download';
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
  });
  if (download || mime.includes('presentationml')) {
    headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  }

  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') {
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    if (headOnly) return new Response(null, { status: 206, headers });
    const stream = Readable.toWeb(createReadStream(absPath, { start: range.start, end: range.end }));
    return new Response(stream as ReadableStream<Uint8Array>, { status: 206, headers });
  }

  headers.set('Content-Length', String(size));
  if (headOnly) return new Response(null, { status: 200, headers });
  const stream = Readable.toWeb(createReadStream(absPath));
  return new Response(stream as ReadableStream<Uint8Array>, { status: 200, headers });
}

export const GET = defineApiRoute((request, ctx) => serveFile(request, ctx, false));
export const HEAD = defineApiRoute((request, ctx) => serveFile(request, ctx, true));
