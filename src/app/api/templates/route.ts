import { getSessionFromRequest } from "@/lib/server/auth";
import { listTemplates } from "@/lib/server/templates";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const session = getSessionFromRequest(request);
  const { searchParams } = new URL(request.url);
  const templates = listTemplates({
    domain: searchParams.get("domain") ?? undefined,
    track: searchParams.get("track") ?? undefined,
    color: searchParams.get("color") ?? undefined,
    style: searchParams.get("style") ?? undefined,
    theme: searchParams.get("theme") ?? undefined,
    kind: searchParams.get("kind") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
  }, session?.user ?? null);
  return Response.json({ ok: true, data: { templates } });
}
