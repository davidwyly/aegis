import { describe, it, expect } from "vitest"
import {
  listBriefVersionCountsByBriefIds,
  listBriefVersionsByBriefIds,
} from "./service"

// Per CLAUDE.md, vitest in this repo covers pure logic only — DB
// integration lives in Playwright + the local hardhat/postgres harness.
// These two tests pin the empty-input branch (skips the bulk query
// entirely, important so a render with zero briefs doesn't issue an
// `IN ()` to Postgres). Deeper grouping coverage runs against a real
// DB in the e2e harness.

describe("listBriefVersionsByBriefIds", () => {
  it("returns an empty Map for empty input without touching the DB", async () => {
    const got = await listBriefVersionsByBriefIds([])
    expect(got.size).toBe(0)
  })
})

describe("listBriefVersionCountsByBriefIds", () => {
  it("returns an empty Map for empty input without touching the DB", async () => {
    const got = await listBriefVersionCountsByBriefIds([])
    expect(got.size).toBe(0)
  })
})
