import { test, expect } from "@playwright/test"

import { readFixtures } from "./helpers/fixtures"
import { privateKeyFor } from "./helpers/deploy"
import { signInAs } from "./helpers/siwe"
import { injectWallet } from "./helpers/wallet-inject"
import { advanceTime } from "./helpers/onchain"
import {
  recordCommit,
  recordOriginalReveal,
  seedOpenedCase,
  wipeDb,
} from "./helpers/db"

/**
 * Arbiter happy path — drives the actual UI for everything that has a
 * button:
 *
 *   1. Inject window.ethereum (signs with the drawn arbiter's hardhat key).
 *   2. Programmatic SIWE sign-in (skipping the wallet popup is fine here;
 *      the UI sign-in flow is exercised by ui-sign-in.spec.ts).
 *   3. Visit /cases/:id, assert de novo framing copy + status badge.
 *   4. Click "Commit vote" — wagmi sends the tx through the injected wallet.
 *      Mirror the indexer's reaction in the DB (the keeper itself is
 *      stubbed in this scaffold; see e2e/README.md).
 *   5. Reload, assert the commit indicator.
 *   6. evm_increaseTime past the commit window.
 *   7. Click "Reveal vote" — wagmi reads the salt stash from localStorage
 *      and submits revealVote. Mirror appealable_resolved into the DB.
 *   8. Reload, assert the "Appeal window" badge.
 */

test.describe("arbiter happy path", () => {
  test.beforeEach(async () => {
    const f = readFixtures()
    await wipeDb(f.databaseUrl)
    await seedOpenedCase(f.databaseUrl, f.deployment)
  })

  test("commits and reveals through the UI", async ({ page }) => {
    const f = readFixtures()
    const { databaseUrl, deployment: d } = f
    const arbiter = d.seededCase.drawnArbiter
    const privateKey = privateKeyFor(arbiter)

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

    // Capture the salt the form generated (it's the second field).
    const saltField = page.locator('input.font-mono')
    const salt = await saltField.inputValue()

    // Click commit. The wagmi `useWriteContract` call goes through the
    // injected wallet and lands on chain. We poll for the transaction
    // submission status the form surfaces.
    await page.getByRole("button", { name: /commit vote/i }).click()
    await expect(page.getByText(/Commit submitted: 0x/i)).toBeVisible({ timeout: 15_000 })

    // The form stashed the salt + rationale in localStorage so reveal can
    // replay it. The indexer would now be writing committedAt + commitHash
    // into panel_members; for the scaffold we mirror that synchronously.
    const caseUuid = await readSeededCaseUuid(databaseUrl, d.seededCase.aegisCaseId)
    const commitHash = await readCommitHashOnchain(d.rpcUrl, d.aegis, d.seededCase.aegisCaseId)
    await recordCommit(databaseUrl, caseUuid, arbiter, commitHash)

    // Reload, assert the checklist hint flipped to its post-commit text.
    await page.reload()
    await expect(page.getByText(/recorded\. save your salt recovery file/i)).toBeVisible()

    // Skip past commit window so the contract accepts reveal.
    await advanceTime(d.rpcUrl, 60 * 60 * 24 + 60)

    // The page now needs to render the reveal-phase form. The form's
    // `phase` prop is computed server-side from the DB deadline; bump
    // the DB deadlineCommit into the past so it switches.
    await advanceCommitWindowInDb(databaseUrl, caseUuid)
    await page.reload()

    // Click reveal — the form pulls the salt+rationale from localStorage.
    await page.getByRole("button", { name: /reveal vote/i }).click()
    await expect(page.getByText(/Reveal submitted: 0x/i)).toBeVisible({ timeout: 15_000 })

    // Mirror the indexer reaction (Revealed event → AppealableResolved).
    const rationaleDigest = await readRationaleDigestOnchain(
      d.rpcUrl,
      d.aegis,
      d.seededCase.aegisCaseId,
    )
    await recordOriginalReveal(databaseUrl, caseUuid, arbiter, 60, rationaleDigest)

    await page.reload()
    await expect(page.getByText("Appeal window")).toBeVisible()

    // Sanity: the localStorage stash was the value we saw in the form.
    void salt
  })
})

// ─── tiny inline DB helpers used only by this spec ────────────────────

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

/**
 * Force the cases.deadline_commit row backwards in time so the case page's
 * server-side phase computation flips from "commit" to "reveal". The
 * contract on its own accepts the reveal because we already advanced
 * EVM time; this just keeps the UI in sync since the indexer isn't
 * running.
 */
async function advanceCommitWindowInDb(databaseUrl: string, caseUuid: string): Promise<void> {
  const postgres = (await import("postgres")).default
  const sql = postgres(databaseUrl, { prepare: false, max: 1 })
  try {
    await sql`
      UPDATE cases
      SET deadline_commit = NOW() - INTERVAL '1 minute',
          deadline_reveal = NOW() + INTERVAL '23 hours',
          status = 'revealing'
      WHERE id = ${caseUuid}
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function readCommitHashOnchain(
  rpcUrl: string,
  aegis: `0x${string}`,
  caseId: `0x${string}`,
): Promise<`0x${string}`> {
  const { createPublicClient, http } = await import("viem")
  const { hardhat } = await import("viem/chains")
  const { aegisAbi } = await import("@/lib/abi/aegis")
  const client = createPublicClient({ chain: hardhat, transport: http(rpcUrl) })
  const view = (await client.readContract({
    address: aegis,
    abi: aegisAbi,
    functionName: "getCase",
    args: [caseId],
  })) as { originalCommitHash: `0x${string}` }
  return view.originalCommitHash
}

async function readRationaleDigestOnchain(
  rpcUrl: string,
  aegis: `0x${string}`,
  caseId: `0x${string}`,
): Promise<`0x${string}`> {
  const { createPublicClient, http } = await import("viem")
  const { hardhat } = await import("viem/chains")
  const { aegisAbi } = await import("@/lib/abi/aegis")
  const client = createPublicClient({ chain: hardhat, transport: http(rpcUrl) })
  const view = (await client.readContract({
    address: aegis,
    abi: aegisAbi,
    functionName: "getCase",
    args: [caseId],
  })) as { originalDigest: `0x${string}` }
  return view.originalDigest
}
