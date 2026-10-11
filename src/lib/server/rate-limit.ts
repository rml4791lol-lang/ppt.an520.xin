// Process-local fixed-window buckets. Good enough for a single-instance deploy;
// multi-instance would need a shared store.

interface Bucket {
  startedAt: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

function cleanup(now: number, windowMs: number): void {
  if (buckets.size < 4096) return;
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt > windowMs * 2) buckets.delete(key);
  }
  while (buckets.size > 8192) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export function hitRateLimit(key: string, opts: { windowMs: number; max: number }): RateLimitResult {
  const now = Date.now();
  cleanup(now, opts.windowMs);
  const current = buckets.get(key);
  if (!current || now - current.startedAt > opts.windowMs) {
    buckets.set(key, { startedAt: now, count: 1 });
    return { allowed: true, count: 1, retryAfterSeconds: 0 };
  }
  current.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((current.startedAt + opts.windowMs - now) / 1000));
  return { allowed: current.count <= opts.max, count: current.count, retryAfterSeconds };
}

/** 一次消耗 cost 个名额；窗口不够则吃掉剩余，不透支。allowed=是否拿满 cost。 */
export function consumeRateLimit(
  key: string,
  opts: { windowMs: number; max: number; cost: number },
): RateLimitResult & { consumed: number } {
  const cost = Math.max(0, Math.floor(Number(opts.cost) || 0));
  const now = Date.now();
  cleanup(now, opts.windowMs);
  let current = buckets.get(key);
  if (!current || now - current.startedAt > opts.windowMs) {
    current = { startedAt: now, count: 0 };
    buckets.set(key, current);
  }
  const remaining = Math.max(0, opts.max - current.count);
  const consumed = Math.min(cost, remaining);
  current.count += consumed;
  const retryAfterSeconds =
    consumed < cost ? Math.max(1, Math.ceil((current.startedAt + opts.windowMs - now) / 1000)) : 0;
  return { allowed: consumed === cost, consumed, count: current.count, retryAfterSeconds };
}

export function resetRateLimit(key: string): void {
  buckets.delete(key);
}
