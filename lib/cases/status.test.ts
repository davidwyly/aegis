import { describe, it, expect } from "vitest"
import {
  CASE_STATUSES,
  isArbiterSafeCaseStatus,
  isResolvedCaseStatus,
  rawStatusesMatchingSanitized,
  sanitizeStatusForArbiter,
  type CaseStatus,
} from "./status"

describe("sanitizeStatusForArbiter", () => {
  it("collapses appeal_* statuses to their base equivalents", () => {
    expect(sanitizeStatusForArbiter("appeal_awaiting_panel")).toBe("awaiting_panel")
    expect(sanitizeStatusForArbiter("appeal_open")).toBe("open")
    expect(sanitizeStatusForArbiter("appeal_revealing")).toBe("revealing")
  })

  it("passes non-appeal statuses through unchanged", () => {
    const passthrough: CaseStatus[] = [
      "awaiting_panel",
      "open",
      "revealing",
      "appealable_resolved",
      "resolved",
      "default_resolved",
      "stalled",
    ]
    for (const s of passthrough) {
      expect(sanitizeStatusForArbiter(s)).toBe(s)
    }
  })

  it("never returns a status starting with 'appeal_'", () => {
    // Drift guard: the appeal_* prefix is the leak signal. If a new
    // appeal_* value is added to CASE_STATUSES and the maintainer
    // forgets to add it to APPEAL_STATUS_MAP, the input would fall
    // through unchanged and this assertion fires. (Note: this is
    // intentionally distinct from `appealable_resolved`, which has a
    // different prefix and is fine for arbiters to see — they have
    // already revealed by then.)
    for (const s of CASE_STATUSES) {
      const sanitized = sanitizeStatusForArbiter(s)
      expect(sanitized.startsWith("appeal_")).toBe(false)
    }
  })

  it("matches an explicit expected mapping", () => {
    // Frozen expectations — adding a new arbiter-visible appeal_*
    // status REQUIRES adding it here so the drift is forced through
    // review rather than silently passing.
    const expected: Record<CaseStatus, CaseStatus> = {
      awaiting_panel: "awaiting_panel",
      open: "open",
      revealing: "revealing",
      appealable_resolved: "appealable_resolved",
      appeal_awaiting_panel: "awaiting_panel",
      appeal_open: "open",
      appeal_revealing: "revealing",
      resolved: "resolved",
      default_resolved: "default_resolved",
      stalled: "stalled",
    }
    for (const s of CASE_STATUSES) {
      expect(sanitizeStatusForArbiter(s)).toBe(expected[s])
    }
  })
})

describe("isResolvedCaseStatus", () => {
  it("returns true only for resolved / default_resolved", () => {
    expect(isResolvedCaseStatus("resolved")).toBe(true)
    expect(isResolvedCaseStatus("default_resolved")).toBe(true)
    expect(isResolvedCaseStatus("stalled")).toBe(false)
    expect(isResolvedCaseStatus("appealable_resolved")).toBe(false)
    expect(isResolvedCaseStatus("open")).toBe(false)
  })
})

describe("isArbiterSafeCaseStatus", () => {
  it("rejects appeal_* statuses", () => {
    expect(isArbiterSafeCaseStatus("appeal_open")).toBe(false)
    expect(isArbiterSafeCaseStatus("appeal_revealing")).toBe(false)
    expect(isArbiterSafeCaseStatus("appeal_awaiting_panel")).toBe(false)
  })

  it("accepts every CASE_STATUSES value that doesn't start with appeal_", () => {
    // Drift-proof: iterate the canonical tuple rather than a
    // hand-picked subset. Future statuses get covered automatically.
    for (const s of CASE_STATUSES) {
      const expected = !s.startsWith("appeal_")
      expect(isArbiterSafeCaseStatus(s)).toBe(expected)
    }
  })

  it("rejects unknown strings", () => {
    expect(isArbiterSafeCaseStatus("bogus")).toBe(false)
    expect(isArbiterSafeCaseStatus("")).toBe(false)
  })
})

describe("rawStatusesMatchingSanitized", () => {
  it("expands `open` to original + appeal commit phases", () => {
    expect(rawStatusesMatchingSanitized("open").sort()).toEqual(
      ["appeal_open", "open"].sort(),
    )
  })

  it("expands `revealing` and `awaiting_panel` similarly", () => {
    expect(rawStatusesMatchingSanitized("revealing").sort()).toEqual(
      ["appeal_revealing", "revealing"].sort(),
    )
    expect(rawStatusesMatchingSanitized("awaiting_panel").sort()).toEqual(
      ["appeal_awaiting_panel", "awaiting_panel"].sort(),
    )
  })

  it("returns just the input for non-expanded statuses", () => {
    expect(rawStatusesMatchingSanitized("resolved")).toEqual(["resolved"])
    expect(rawStatusesMatchingSanitized("stalled")).toEqual(["stalled"])
    expect(rawStatusesMatchingSanitized("appealable_resolved")).toEqual([
      "appealable_resolved",
    ])
  })

  it("round-trips with sanitizeStatusForArbiter", () => {
    // For every raw status that sanitizes to X, X's expansion must
    // include that raw status. Pins the inverse-map relationship.
    for (const s of CASE_STATUSES) {
      const sanitized = sanitizeStatusForArbiter(s)
      expect(rawStatusesMatchingSanitized(sanitized)).toContain(s)
    }
  })
})
