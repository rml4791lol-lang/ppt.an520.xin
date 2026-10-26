import { jsonOk, readJsonBody } from '@/lib/server/http';
import { requireUser } from '@/lib/server/auth';
import { defineApiRoute, paramOf } from '@/lib/server/generation/route';
import { deleteProject, renameProject } from '@/lib/server/generation/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 改标题：{title} */
export const PATCH = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  const body = await readJsonBody(request);
  return jsonOk(renameProject(user.id, id, String(body.title ?? '')));
}, { mutation: true });

/** 软删（7 天保留策略的物理清理在运维层） */
export const DELETE = defineApiRoute(async (request, ctx) => {
  const { user } = requireUser(request);
  const id = await paramOf(ctx, 'id');
  return jsonOk(deleteProject(user.id, id));
}, { mutation: true });
