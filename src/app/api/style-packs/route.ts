import { getSessionFromRequest } from "@/lib/server/auth";
import { visibleStylePacks } from "@/lib/server/templates";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const session = getSessionFromRequest(request);
  return Response.json({ ok: true, data: { stylePacks: visibleStylePacks(session?.user ?? null) } });
}
