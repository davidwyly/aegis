import "server-only"

interface Bucket {
  windowStartMs: number
  count: number
}

interface ConsumeInput {
  buckets: Map<string, Bucket>
  key: string
  limit: number
  windowMs: number
  nowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

/** Pure fixed-window counter — exported for unit testing. */
export function consumeFixedWindow({
  buckets,
  key,
  limit,
  windowMs,
  nowMs,
}: ConsumeInput): RateLimitResult {
  const cur = buckets.get(key)
  if (!cur || nowMs - cur.windowStartMs >= windowMs) {
    buckets.set(key, { windowStartMs: nowMs, count: 1 })
    return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 }
  }
  if (cur.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((cur.windowStartMs + windowMs - nowMs) / 1000),
      ),
    }
  }
  cur.count += 1
  return {
    allowed: true,
    remaining: Math.max(0, limit - cur.count),
    retryAfterSeconds: 0,
  }
}

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 10_000

const IP_HEADERS = ["x-forwarded-for", "cf-connecting-ip", "x-real-ip"] as const
type IpHeader = (typeof IP_HEADERS)[number]

function configuredIpHeader(): IpHeader {
  const raw = process.env.RATE_LIMIT_IP_HEADER
  return IP_HEADERS.find((h) => h === raw) ?? "x-forwarded-for"
}

function clientIp(req: Request): string {
  const header = configuredIpHeader()
  const value = req.headers.get(header)
  if (!value) return "unknown"
  if (header === "x-forwarded-for") {
    return value.split(",")[0]?.trim() || "unknown"
  }
  return value.trim() || "unknown"
}

function pruneIfFull(nowMs: number, windowMs: number): void {
  if (buckets.size < MAX_BUCKETS) return
  for (const [k, b] of buckets) {
    if (nowMs - b.windowStartMs >= windowMs) {
      buckets.delete(k)
    }
  }
}

/**
 * Build a key from server-controlled scope + non-rotatable client identity.
 * Deliberately limited to scope + IP — using attacker-rotatable inputs
 * (User-Agent, custom headers, cookies) lets a client mint unlimited
 * buckets and bypass the limit entirely.
 */
export function rateLimitKey(req: Request, scope: string): string {
  return `${scope}:${clientIp(req)}`
}

/**
 * Consume one unit from the (scope, IP) bucket. Returns the result; throws
 * `RateLimitError` if denied so callers can rethrow or convert to 429.
 *
 * In-memory only — single-process deployments are fine; multi-instance
 * hosts should put a stickier rate limiter at the edge (Cloudflare,
 * upstream nginx, etc.) since each Next instance has its own bucket map.
 */
export function enforceRateLimit(
  req: Request,
  scope: string,
  { limit, windowMs, nowMs = Date.now() }: { limit: number; windowMs: number; nowMs?: number },
): void {
  pruneIfFull(nowMs, windowMs)
  const result = consumeFixedWindow({
    buckets,
    key: rateLimitKey(req, scope),
    limit,
    windowMs,
    nowMs,
  })
  if (!result.allowed) {
    throw new RateLimitError(result.retryAfterSeconds)
  }
}

export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    super(`Rate limit exceeded; retry in ${retryAfterSeconds}s`)
    this.name = "RateLimitError"
  }
}
