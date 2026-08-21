import { getOnlyOfficeReleaseResponse } from '@/lib/server/onlyoffice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return getOnlyOfficeReleaseResponse();
}
