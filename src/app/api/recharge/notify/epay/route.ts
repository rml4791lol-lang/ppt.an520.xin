import { handleEpayNotify } from '@/lib/server/recharge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Server-to-server callback: no session cookie, no x-anppt-action guard;
// authenticity comes from the epay MD5 sign (skipped only in mock mode).
async function handle(request: Request): Promise<Response> {
  const params: Record<string, string> = {};
  const url = new URL(request.url);
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const body = await request.text();
      new URLSearchParams(body).forEach((value, key) => {
        params[key] = value;
      });
    } else if (contentType.includes('application/json')) {
      const parsed = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        params[key] = String(value);
      }
    }
  }
  const result = handleEpayNotify(params);
  return new Response(result, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
