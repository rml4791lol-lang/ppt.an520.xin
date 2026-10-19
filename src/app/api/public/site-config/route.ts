import { getSiteConfig } from "@/data/site-config";

const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
};

export function GET() {
  const config = getSiteConfig();
  return Response.json({ ok: true, data: config }, { headers: CACHE_HEADERS });
}
