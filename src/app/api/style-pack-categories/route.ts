import { STYLE_PACK_CATEGORIES } from "@/data/style-packs";

export function GET() {
  return Response.json({ ok: true, data: { categories: STYLE_PACK_CATEGORIES } });
}
