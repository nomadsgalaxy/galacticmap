// Reject-before-DB rate limiter (plan.md §9). In-memory token bucket for the single-container
// default; swap the implementation for Redis/Upstash at multi-instance without touching callers.
type Bucket = { tokens: number; updated: number };

export interface RateLimiter {
  /** ratePerSec = refill rate; burst = bucket capacity. Returns allowed + retryAfter (s). */
  check(key: string, ratePerSec: number, burst: number): { allowed: boolean; retryAfter: number };
}

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 50_000; // crude bound so a flood of distinct keys can't grow memory unbounded

export const memoryRateLimiter: RateLimiter = {
  check(key, ratePerSec, burst) {
    const now = Date.now();
    if (buckets.size > MAX_KEYS) buckets.clear(); // simplest backstop; fine for self-host scale
    const b = buckets.get(key) ?? { tokens: burst, updated: now };
    const elapsed = (now - b.updated) / 1000;
    b.tokens = Math.min(burst, b.tokens + elapsed * Math.max(ratePerSec, 0.0001));
    b.updated = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      buckets.set(key, b);
      return { allowed: true, retryAfter: 0 };
    }
    buckets.set(key, b);
    return { allowed: false, retryAfter: Math.ceil((1 - b.tokens) / Math.max(ratePerSec, 0.0001)) };
  },
};

export const rateLimiter: RateLimiter = memoryRateLimiter;
