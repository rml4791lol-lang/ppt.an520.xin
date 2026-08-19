import { SHOWCASE_CASES } from "@/data/showcase-cases";

export function GET(request: Request) {
  const placement = new URL(request.url).searchParams.get("placement");
  const cases = placement
    ? SHOWCASE_CASES.filter(
        (c) => c.placements.length === 0 || c.placements.includes(placement),
      )
    : SHOWCASE_CASES;
  return Response.json({ ok: true, data: { cases } });
}
