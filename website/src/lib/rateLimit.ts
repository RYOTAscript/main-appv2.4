/**
 * Tiny in-memory fixed-window rate limiter. Keyed by an arbitrary id (usually
 * the caller IP). Intended as a cheap first line of defence against abuse of
 * the public endpoints (license verify, app session).
 *
 * Caveat: state lives in process memory, so on serverless/multi-instance hosts
 * each instance keeps its own window — this slows abuse, it doesn't guarantee a
 * global cap. For a hard global limit, back it with Redis/Upstash. It is enough
 * for a low-traffic $5 product and adds no dependency.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number) {
  // Opportunistically drop expired buckets so the map can't grow unbounded.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

/**
 * Consume one token for `id`. Allows `limit` requests per `windowMs`.
 */
export function rateLimit(
  id: string,
  limit = 30,
  windowMs = 60_000,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(id);
  if (!existing || existing.resetAt <= now) {
    buckets.set(id, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSec: 0 };
  }

  if (existing.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return { ok: true, remaining: limit - existing.count, retryAfterSec: 0 };
}

/** Best-effort client IP from common proxy headers (Vercel sets these). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
