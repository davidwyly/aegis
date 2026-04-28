import { describe, it, expect } from "vitest"
import { assertNonceFresh, NONCE_TTL_MS } from "./siwe"

describe("assertNonceFresh", () => {
  it("throws if the row is undefined (already-consumed or unknown nonce)", () => {
    expect(() => assertNonceFresh(undefined)).toThrow(/Unknown or already-consumed/)
  })

  it("accepts a fresh row", () => {
    const issuedAt = new Date()
    expect(() => assertNonceFresh({ issuedAt })).not.toThrow()
  })

  it("rejects a row past the TTL", () => {
    const issuedAt = new Date(Date.now() - NONCE_TTL_MS - 1_000)
    expect(() => assertNonceFresh({ issuedAt })).toThrow(/expired/)
  })

  it("rejects exactly at the TTL boundary +1ms", () => {
    const now = new Date("2026-01-01T00:00:00Z")
    const issuedAt = new Date(now.getTime() - NONCE_TTL_MS - 1)
    expect(() => assertNonceFresh({ issuedAt }, now)).toThrow(/expired/)
  })

  it("accepts a row exactly at the TTL boundary", () => {
    const now = new Date("2026-01-01T00:00:00Z")
    const issuedAt = new Date(now.getTime() - NONCE_TTL_MS)
    expect(() => assertNonceFresh({ issuedAt }, now)).not.toThrow()
  })
})
