import { getSessionFromRequest } from "@/lib/server/auth";
import { visibleStylePacks } from "@/lib/server/templates";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  'Cache-Control': 'private, max-age=60',
  Vary: 'Cookie',
};

export function GET(request: Request) {
  const session = getSessionFromRequest(request);
  return Response.json(
    { ok: true, data: { stylePacks: visibleStylePacks(session?.user ?? null) } },
    { headers: CACHE_HEADERS },
  );
}
