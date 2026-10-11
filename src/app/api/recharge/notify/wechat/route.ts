import { handleWechatNotify } from '@/lib/server/recharge';
import { logProblem } from '@/lib/server/problem-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Server-to-server callback: no session cookie, no x-anppt-action guard;
// authenticity comes from the wechat platform signature (skipped only in mock mode).
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  try {
    const result = await handleWechatNotify(rawBody, headers);
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    logProblem({ category: 'payments', level: 'error', message: '微信支付回调异常', detail: error });
    return Response.json({ code: 'FAIL', message: 'internal error' }, { status: 500 });
  }
}
