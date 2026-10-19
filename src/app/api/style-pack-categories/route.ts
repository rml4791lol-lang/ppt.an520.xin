import { STYLE_PACK_CATEGORIES } from "@/data/style-packs";

const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
};

export function GET() {
  return Response.json(
    { ok: true, data: { categories: STYLE_PACK_CATEGORIES } },
    { headers: CACHE_HEADERS },
  );
}
