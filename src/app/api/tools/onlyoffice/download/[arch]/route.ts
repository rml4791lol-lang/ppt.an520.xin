import { getOnlyOfficeDownloadResponse } from '@/lib/server/onlyoffice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ arch: string }> },
): Promise<Response> {
  const { arch } = await context.params;
  return getOnlyOfficeDownloadResponse(request, arch);
}
