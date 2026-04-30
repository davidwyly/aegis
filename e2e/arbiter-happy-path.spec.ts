import { test, expect } from "@playwright/test"

import { readFixtures } from "./helpers/fixtures"
import { privateKeyFor } from "./helpers/deploy"
import { signInAs } from "./helpers/siwe"
import { commitVote, revealVote, advanceTime } from "./helpers/onchain"
import { recordCommit, recordOriginalReveal, seedOpenedCase, wipeDb } from "./helpers/db"

/**
 * Arbiter happy path:
 *
 *   1. Sign in (programmatic SIWE) as the arbiter VRF assigned.
 *   2. Visit /cases/:id, assert de novo framing copy + status badge.
 *   3. commitVote on-chain via viem; mirror the indexer side-effect into
 *      the DB (panel_members.committedAt + commit_hash).
 *   4. Reload page, assert the commit indicator shows.
 *   5. Skip past the commit window on hardhat.
 *   6. revealVote on-chain via viem; mirror the indexer side-effect into
 *      the DB (cases.status = 'appealable_resolved').
 *   7. Reload page, assert the "Appeal window" badge.
 *
 * The on-chain interactions are issued from the test process directly
 * because the wagmi UI requires a connected wallet. Mocking window.ethereum
 * is a follow-up; for v1 we exercise everything the assigned arbiter
 * actually sees in the DOM.
 */

test.describe("arbiter happy path", () => {
  test.beforeEach(async () => {
    const f = readFixtures()
    await wipeDb(f.databaseUrl)
    await seedOpenedCase(f.databaseUrl, f.deployment)
  })

  test("commits and reveals on a freshly opened case", async ({ page }) => {
    const f = readFixtures()
    const { databaseUrl, deployment: d } = f
    const arbiter = d.seededCase.drawnArbiter
    const privateKey = privateKeyFor(arbiter)

    // Step 1: sign in as the drawn arbiter.
    await page.goto("/")
    await signInAs(page, privateKey)

    // Step 2: visit the case workspace, assert de novo framing.
    await page.goto(`/cases/${d.seededCase.aegisCaseId}`)
    await expect(page.getByRole("heading", { name: "Case at arbitration" })).toBeVisible()
    await expect(
      page.getByText(/randomly selected to arbitrate this case/i),
    ).toBeVisible()
    await expect(page.getByText("Open · commits")).toBeVisible()

    // Step 3: commit on-chain. We replay the same hash math the UI uses,
    // so the contract accepts the matching reveal later.
    const commit = await commitVote(
      { rpcUrl: d.rpcUrl, aegis: d.aegis, privateKey },
      d.seededCase.aegisCaseId,
      60, // 60% to party A
      "Party A's evidence is more credible.",
    )
    // Re-fetch the caseUuid we just re-seeded — beforeEach already created
    // one; pull its id.
    const caseUuid = await readSeededCaseUuid(databaseUrl, d.seededCase.aegisCaseId)
    await recordCommit(databaseUrl, caseUuid, arbiter, commit.commitHash)

    // Step 4: reload, assert commit indicator. The arbiter checklist's
    // "Commit your verdict" hint flips to "Recorded…" once committedAt is set.
    await page.reload()
    await expect(page.getByText(/recorded\. save your salt recovery file/i)).toBeVisible()

    // Step 5: skip past the commit window so the contract accepts reveal.
    await advanceTime(d.rpcUrl, 60 * 60 * 24 + 60) // 24h + 60s

    // Step 6: reveal on-chain.
    await revealVote(
      { rpcUrl: d.rpcUrl, aegis: d.aegis, privateKey },
      d.seededCase.aegisCaseId,
      commit,
    )
    await recordOriginalReveal(databaseUrl, caseUuid, arbiter, 60, commit.rationaleDigest)

    // Step 7: reload, assert appealable_resolved badge surfaced. The
    // arbiter's view collapses appeal-distinct labels onto the original
    // phase, but `appealable_resolved` is not phase-scoped — both
    // arbiters and parties see "Appeal window".
    await page.reload()
    await expect(page.getByText("Appeal window")).toBeVisible()
  })
})

// Tiny inline helper so the spec doesn't need its own module.
async function readSeededCaseUuid(databaseUrl: string, aegisCaseId: string): Promise<string> {
  const postgres = (await import("postgres")).default
  const sql = postgres(databaseUrl, { prepare: false, max: 1 })
  try {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM cases WHERE case_id = ${aegisCaseId.toLowerCase()} LIMIT 1
    `
    if (!row) throw new Error(`No case row for ${aegisCaseId}`)
    return row.id
  } finally {
    await sql.end({ timeout: 5 })
  }
}
