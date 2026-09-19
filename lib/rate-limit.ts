type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const SWEEP_EVERY_MS = 60_000;
let lastSweep = 0;

/**
 * Drop expired buckets so a long-lived (warm) serverless instance does not
 * accumulate one Map entry per client IP / room / grant forever.
 */
function sweep(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Fixed-window limiter for a single process (PRD 16.5).
 * The MVP runs one app instance; with multiple instances this still bounds
 * each instance, which is acceptable for a 2-person product until a shared
 * store exists (PRD Phase 4 explicitly defers Redis).
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSeconds: 0 };
  }
  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }
  bucket.count += 1;
  return { ok: true, retryAfterSeconds: 0 };
}

export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please slow down." }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfterSeconds || 1),
      },
    },
  );
}
