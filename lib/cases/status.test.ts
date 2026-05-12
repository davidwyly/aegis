import { describe, it, expect } from "vitest"
import {
  CASE_STATUSES,
  isResolvedCaseStatus,
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

  it("covers every case status", () => {
    // Guard against drift: if a new status is added to CASE_STATUSES,
    // this test forces a decision about whether it leaks appeal context.
    for (const s of CASE_STATUSES) {
      const sanitized = sanitizeStatusForArbiter(s)
      expect(CASE_STATUSES).toContain(sanitized)
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
