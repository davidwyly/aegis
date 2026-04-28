import { describe, it, expect } from "vitest"
import { consumeFixedWindow } from "./rate-limit"

describe("consumeFixedWindow", () => {
  it("first call seeds a new bucket and is allowed", () => {
    const buckets = new Map()
    const r = consumeFixedWindow({ buckets, key: "k", limit: 3, windowMs: 1000, nowMs: 1000 })
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(2)
    expect(r.retryAfterSeconds).toBe(0)
  })

  it("counts up to the limit then denies", () => {
    const buckets = new Map()
    consumeFixedWindow({ buckets, key: "k", limit: 3, windowMs: 1000, nowMs: 100 })
    consumeFixedWindow({ buckets, key: "k", limit: 3, windowMs: 1000, nowMs: 200 })
    consumeFixedWindow({ buckets, key: "k", limit: 3, windowMs: 1000, nowMs: 300 })
    const denied = consumeFixedWindow({
      buckets,
      key: "k",
      limit: 3,
      windowMs: 1000,
      nowMs: 400,
    })
    expect(denied.allowed).toBe(false)
    expect(denied.remaining).toBe(0)
    expect(denied.retryAfterSeconds).toBeGreaterThan(0)
  })

  it("resets the bucket once the window expires", () => {
    const buckets = new Map()
    consumeFixedWindow({ buckets, key: "k", limit: 1, windowMs: 100, nowMs: 0 })
    const denied = consumeFixedWindow({ buckets, key: "k", limit: 1, windowMs: 100, nowMs: 50 })
    expect(denied.allowed).toBe(false)
    const fresh = consumeFixedWindow({ buckets, key: "k", limit: 1, windowMs: 100, nowMs: 200 })
    expect(fresh.allowed).toBe(true)
    expect(fresh.remaining).toBe(0)
  })

  it("isolates buckets by key", () => {
    const buckets = new Map()
    consumeFixedWindow({ buckets, key: "a", limit: 1, windowMs: 1000, nowMs: 0 })
    const b = consumeFixedWindow({ buckets, key: "b", limit: 1, windowMs: 1000, nowMs: 0 })
    expect(b.allowed).toBe(true)
  })

  it("retryAfterSeconds rounds up to at least 1", () => {
    const buckets = new Map()
    consumeFixedWindow({ buckets, key: "k", limit: 1, windowMs: 1100, nowMs: 0 })
    const r = consumeFixedWindow({ buckets, key: "k", limit: 1, windowMs: 1100, nowMs: 1099 })
    expect(r.allowed).toBe(false)
    expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1)
  })
})
