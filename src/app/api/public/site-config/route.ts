import { getSiteConfig } from "@/data/site-config";

export function GET() {
  const config = getSiteConfig();
  return Response.json({ ok: true, data: config });
}
