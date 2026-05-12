import { describe, expect, it } from "vitest"
import { sanitiseFileName, sanitiseGroupName } from "./evidence"

// Pure-logic tests for the upload + ZIP sanitisers. Both run before
// any DB hit, so vitest can exercise them in isolation.

describe("sanitiseFileName", () => {
  it("accepts an alphanumeric+ext filename verbatim", () => {
    expect(sanitiseFileName("invoice-7.pdf")).toBe("invoice-7.pdf")
  })

  it("replaces disallowed characters with underscores", () => {
    expect(sanitiseFileName("résumé final v2.pdf")).toBe("r_sum__final_v2.pdf")
  })

  it("strips leading dots so the output isn't a hidden file", () => {
    expect(sanitiseFileName(".env")).toBe("env")
  })

  it("clamps to 200 characters", () => {
    const long = "x".repeat(500) + ".txt"
    const got = sanitiseFileName(long)!
    expect(got.length).toBe(200)
  })

  it("rejects an empty input", () => {
    expect(sanitiseFileName("")).toBeNull()
  })

  it("rejects a name that becomes empty after stripping leading dots", () => {
    expect(sanitiseFileName("....")).toBeNull()
  })

  it("rejects '.' and '..' outright", () => {
    expect(sanitiseFileName(".")).toBeNull()
    expect(sanitiseFileName("..")).toBeNull()
  })

  it("neutralises leading traversal by stripping leading dots", () => {
    // `../etc/passwd` → slash→`_` → `.._etc_passwd` → leading-dot strip
    // → `_etc_passwd`. The traversal is defused, not rejected.
    expect(sanitiseFileName("../etc/passwd")).toBe("_etc_passwd")
  })

  it("rejects names that still contain '..' after the leading-dot strip", () => {
    expect(sanitiseFileName("foo..bar.txt")).toBeNull()
    expect(sanitiseFileName("..bad..")).toBeNull()
  })

  it("sanitises path-separator-only names to underscores", () => {
    // After replacement these become a literal "_" — accepted as a
    // normal (if useless) filename. Only the literal . / .. /
    // traversal cases are zip-slip-able, which is what we care about.
    expect(sanitiseFileName("/")).toBe("_")
    expect(sanitiseFileName("\\")).toBe("_")
  })
})

describe("sanitiseGroupName", () => {
  it("returns null for null / undefined / empty input", () => {
    expect(sanitiseGroupName(null)).toBeNull()
    expect(sanitiseGroupName(undefined)).toBeNull()
    expect(sanitiseGroupName("")).toBeNull()
    expect(sanitiseGroupName("   ")).toBeNull()
  })

  it("accepts the documented suggestion set", () => {
    for (const g of ["documents", "media", "exhibits", "other"]) {
      expect(sanitiseGroupName(g)).toBe(g)
    }
  })

  it("rejects '.' / '..' outright", () => {
    expect(sanitiseGroupName(".")).toBeNull()
    expect(sanitiseGroupName("..")).toBeNull()
  })

  it("neutralises leading traversal into a safe name", () => {
    // `../escape` → slash→`_` → `.._escape` → leading-dot strip → `_escape`.
    expect(sanitiseGroupName("../escape")).toBe("_escape")
  })

  it("rejects '..' segments that survive the leading-dot strip", () => {
    expect(sanitiseGroupName("foo..bar")).toBeNull()
  })

  it("strips leading dots and clamps to 64 chars", () => {
    expect(sanitiseGroupName(".hidden")).toBe("hidden")
    const long = "g".repeat(100)
    expect(sanitiseGroupName(long)!.length).toBe(64)
  })
})
