// 带动态路由 ctx 的 route 包装（既有 http.defineRoute 只透传 request，动态段需要 ctx.params）。
// 行为与 http.defineRoute 完全一致：mutation 走 guardMutationRequest，异常走 toErrorResponse。
import { guardMutationRequest, toErrorResponse } from '../http';

// Next 16：动态路由参数是 Promise，必须 await（见 node_modules/next/dist/docs route.md）。
export interface ApiRouteContext {
  params: Promise<Record<string, string | string[] | undefined>>;
}

type ApiRouteHandler = (request: Request, ctx: ApiRouteContext) => Promise<Response> | Response;

export function defineApiRoute(handler: ApiRouteHandler, opts: { mutation?: boolean } = {}) {
  return async (request: Request, ctx: ApiRouteContext): Promise<Response> => {
    if (opts.mutation) {
      const blocked = guardMutationRequest(request);
      if (blocked) return blocked;
    }
    try {
      return await handler(request, ctx);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/** 取动态段（单值） */
export async function paramOf(ctx: ApiRouteContext, key: string): Promise<string> {
  const params = await ctx.params;
  const value = params?.[key];
  return String(Array.isArray(value) ? value[0] : value || '');
}

/** 取动态段（catch-all 数组） */
export async function paramsOf(ctx: ApiRouteContext, key: string): Promise<string[]> {
  const params = await ctx.params;
  const value = params?.[key];
  if (Array.isArray(value)) return value.map(String);
  return value ? [String(value)] : [];
}
