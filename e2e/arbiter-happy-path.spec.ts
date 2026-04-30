import { test, expect } from "@playwright/test"

import { readFixtures } from "./helpers/fixtures"
import { privateKeyFor } from "./helpers/deploy"
import { signInAs } from "./helpers/siwe"
import { injectWallet } from "./helpers/wallet-inject"
import { advanceTime } from "./helpers/onchain"
import { wipeDb } from "./helpers/db"
import { tickKeeper } from "./helpers/keeper"

/**
 * Arbiter happy path — drives the actual UI for everything that has a
 * button, and uses the real keeper indexer to mirror chain state into
 * the DB after each on-chain mutation:
 *
 *   1. Inject window.ethereum (signs with the drawn arbiter's hardhat key).
 *   2. Programmatic SIWE sign-in. (UI sign-in flow has its own spec.)
 *   3. Visit /cases/:id, assert de novo framing copy + status badge.
 *   4. Click "Commit vote" — wagmi sends the tx through the injected wallet.
 *      Tick the keeper so panel_members.committedAt + commitHash land.
 *   5. Reload, assert the commit indicator.
 *   6. evm_increaseTime past the commit window + nudge the DB deadlines
 *      so the page's phase computation flips.
 *   7. Click "Reveal vote" — wagmi reads the salt stash from localStorage.
 *      Tick the keeper so cases.status flips to appealable_resolved.
 *   8. Reload, assert "Appeal window" badge.
 */

test.describe("arbiter happy path", () => {
  test.beforeEach(async () => {
    const f = readFixtures()
    // Reset state. After wipe the keeper rebuilds cases + panel_members
    // by re-scanning all logs from block 0.
    await wipeDb(f.databaseUrl)
    await tickKeeper({
      databaseUrl: f.databaseUrl,
      chainId: f.deployment.chainId,
      rpcUrl: f.deployment.rpcUrl,
      aegisAddress: f.deployment.aegis,
    })
  })

  test("commits and reveals through the UI", async ({ page }) => {
    const f = readFixtures()
    const { databaseUrl, deployment: d } = f
    const arbiter = d.seededCase.drawnArbiter
    const privateKey = privateKeyFor(arbiter)
    const indexerArgs = {
      databaseUrl,
      chainId: d.chainId,
      rpcUrl: d.rpcUrl,
      aegisAddress: d.aegis,
    }

    // Inject wallet BEFORE the first goto so wagmi sees window.ethereum
    // on its first render.
    await injectWallet(page, privateKey, d.rpcUrl)

    // Sign in via the API (cookie-based) — separate spec covers UI sign-in.
    await page.goto("/")
    await signInAs(page, privateKey)

    // Visit the case workspace.
    await page.goto(`/cases/${d.seededCase.aegisCaseId}`)
    await expect(page.getByRole("heading", { name: "Case at arbitration" })).toBeVisible()
    await expect(
      page.getByText(/randomly selected to arbitrate this case/i),
    ).toBeVisible()
    await expect(page.getByText("Open · commits")).toBeVisible()

    // Fill in the commit form. Default Party A % is 50; bump to 60 to
    // verify the field round-trips to the contract correctly.
    await page.getByLabel("Party A %").fill("60")
    await page.getByPlaceholder("Why party A should receive this share.").fill(
      "Party A's evidence is more credible.",
    )

    // Click commit. The wagmi `useWriteContract` call goes through the
    // injected wallet and lands on chain.
    await page.getByRole("button", { name: /commit vote/i }).click()
    await expect(page.getByText(/Commit submitted: 0x/i)).toBeVisible({ timeout: 15_000 })

    // Tick the keeper. It picks up the Committed event off-chain and
    // stamps committedAt + commitHash on the panel_members row.
    await tickKeeper(indexerArgs)

    // Reload, assert the checklist hint flipped to its post-commit text.
    await page.reload()
    await expect(page.getByText(/recorded\. save your salt recovery file/i)).toBeVisible()

    // Skip past commit window so the contract accepts reveal.
    await advanceTime(d.rpcUrl, 60 * 60 * 24 + 60)

    // The case page derives "phase" from the cases.deadline_commit row,
    // which the indexer doesn't update from time-only events. Flip the
    // DB deadline so the UI shows the reveal-phase form.
    await advanceCommitWindowInDb(databaseUrl, d.seededCase.aegisCaseId)
    await page.reload()

    // Click reveal — the form pulls the salt+rationale from localStorage.
    await page.getByRole("button", { name: /reveal vote/i }).click()
    await expect(page.getByText(/Reveal submitted: 0x/i)).toBeVisible({ timeout: 15_000 })

    // Tick the keeper. Now applyRevealed reads getCase() and translates
    // the on-chain CaseState.AppealableResolved into the DB status.
    await tickKeeper(indexerArgs)

    await page.reload()
    await expect(page.getByText("Appeal window")).toBeVisible()
  })
})

/**
 * Force the cases.deadline_commit row backwards in time so the case page's
 * server-side phase computation flips from "commit" to "reveal". The
 * contract on its own accepts the reveal because we already advanced
 * EVM time; this keeps the UI's view of the deadline aligned. The keeper
 * doesn't update DB deadlines for time-only transitions (no event), so
 * tests have to nudge it directly.
 */
async function advanceCommitWindowInDb(
  databaseUrl: string,
  aegisCaseId: string,
): Promise<void> {
  const postgres = (await import("postgres")).default
  const sql = postgres(databaseUrl, { prepare: false, max: 1 })
  try {
    await sql`
      UPDATE cases
      SET deadline_commit = NOW() - INTERVAL '1 minute',
          deadline_reveal = NOW() + INTERVAL '23 hours'
      WHERE case_id = ${aegisCaseId.toLowerCase()}
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}
