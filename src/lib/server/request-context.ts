import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface RequestContext {
  requestId: string;
  method: string;
  route: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

function routePath(request: Request): string {
  try {
    return new URL(request.url).pathname.slice(0, 240);
  } catch {
    return '';
  }
}

export function createRequestContext(request: Request): RequestContext {
  return {
    requestId: `req_${randomBytes(12).toString('hex')}`,
    method: request.method.toUpperCase(),
    route: routePath(request),
  };
}

export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
