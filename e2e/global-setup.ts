import { writeFixtures } from "./helpers/fixtures"
import { startEmbeddedPg, E2E_DATABASE_URL } from "./helpers/pg"
import { deployFixture } from "./helpers/deploy"
import { wipeDb } from "./helpers/db"
import { tickKeeper } from "./helpers/keeper"

/**
 * Playwright `globalSetup`. Runs once before any spec.
 *
 *   1. Boot embedded postgres on a fixed loopback port.
 *   2. Apply the project's drizzle schema.
 *   3. Set DATABASE_URL so the keeper can read it on first DB call.
 *   4. Deploy Aegis + mocks against the running hardhat node.
 *   5. Open one dispute, fulfill mock VRF.
 *   6. Tick the real keeper indexer — it picks up CaseRequested →
 *      CaseOpened → ArbiterDrawn from the chain logs and seeds the
 *      cases + panel_members rows.
 *   7. Persist artifact addresses + URLs to e2e/.fixtures.json.
 *   8. Mutate process.env so Playwright's webServer (Next dev) inherits
 *      the right DATABASE_URL + contract addresses.
 *
 * Hardhat is expected to already be running (`pnpm contracts:node` in
 * another terminal). globalSetup hard-fails with a useful message if
 * it isn't.
 */
async function globalSetup(): Promise<void> {
  console.log("[e2e] starting embedded postgres + applying schema…")
  await startEmbeddedPg()

  // Set DATABASE_URL early — the keeper's drizzle client reads it on
  // first lazy access. Same env is inherited by the Next dev server
  // when Playwright's `webServer` block boots later.
  process.env.DATABASE_URL = E2E_DATABASE_URL

  console.log("[e2e] deploying Aegis + mocks against hardhat…")
  const deployment = await deployFixture()

  console.log("[e2e] wiping DB + indexing the open case via the real keeper…")
  await wipeDb(E2E_DATABASE_URL)
  await tickKeeper({
    databaseUrl: E2E_DATABASE_URL,
    chainId: deployment.chainId,
    rpcUrl: deployment.rpcUrl,
    aegisAddress: deployment.aegis,
  })

  writeFixtures({ databaseUrl: E2E_DATABASE_URL, deployment })

  process.env.NEXT_PUBLIC_AEGIS_HARDHAT = deployment.aegis
  process.env.NEXT_PUBLIC_VAULTRA_ADAPTER_HARDHAT = deployment.escrow
  process.env.NEXT_PUBLIC_ELCP_HARDHAT = deployment.elcp
  process.env.NEXT_PUBLIC_USDC_HARDHAT = deployment.usdc
  process.env.NEXT_PUBLIC_HARDHAT_RPC_URL = deployment.rpcUrl
  // iron-session needs a 32-byte secret. Deterministic for tests is fine.
  process.env.SESSION_PASSWORD ??= "e2e-session-password-32bytes-min!!"

  console.log("[e2e] globalSetup ready.")
  console.log(`         drawn arbiter: ${deployment.seededCase.drawnArbiter}`)
  console.log(`         case id: ${deployment.seededCase.aegisCaseId}`)
}

export default globalSetup
