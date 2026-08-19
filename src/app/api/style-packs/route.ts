import { STYLE_PACKS } from "@/data/style-packs";

export function GET() {
  return Response.json({ ok: true, data: { stylePacks: STYLE_PACKS } });
}
