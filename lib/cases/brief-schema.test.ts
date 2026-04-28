import { describe, it, expect } from "vitest"
import { briefBodySchema } from "./service"

describe("briefBodySchema", () => {
  it("accepts a normal brief", () => {
    expect(briefBodySchema.parse("My case is solid.")).toEqual("My case is solid.")
  })

  it("trims surrounding whitespace", () => {
    expect(briefBodySchema.parse("   hi   ")).toEqual("hi")
  })

  it("rejects empty / whitespace-only briefs", () => {
    expect(() => briefBodySchema.parse("")).toThrow()
    expect(() => briefBodySchema.parse("   ")).toThrow()
  })

  it("rejects briefs over 8 KB", () => {
    const oversize = "x".repeat(8_001)
    expect(() => briefBodySchema.parse(oversize)).toThrow()
  })

  it("accepts exactly 8 KB", () => {
    const limit = "x".repeat(8_000)
    expect(briefBodySchema.parse(limit)).toHaveLength(8_000)
  })
})
