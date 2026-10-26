import { defineApiRoute, paramOf } from "@/lib/server/generation/route";
import { getSessionFromRequest } from "@/lib/server/auth";
import { getTemplate, getTemplatePages, isGatedPackVisible, resolveTemplateKind } from "@/lib/server/templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineApiRoute(async (request, ctx) => {
  const id = decodeURIComponent(await paramOf(ctx, "id"));
  const template = getTemplate(id);
  const session = getSessionFromRequest(request);
  // 门控测试包对不可见用户按 404 处理（不暴露资产存在性）
  if (!template || !isGatedPackVisible(template, session?.user ?? null)) {
    return Response.json({ ok: false, error: "模板不存在" }, { status: 404 });
  }
  return Response.json({
    ok: true,
    data: {
      template: {
        ...template,
        kind: resolveTemplateKind(template),
        templatePages: getTemplatePages(template),
      },
    },
  });
});
