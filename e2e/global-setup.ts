import { writeFixtures } from "./helpers/fixtures"
import { startEmbeddedPg, E2E_DATABASE_URL } from "./helpers/pg"
import { deployFixture } from "./helpers/deploy"
import { seedOpenedCase, wipeDb } from "./helpers/db"

/**
 * Playwright `globalSetup`. Runs once before any spec.
 *
 *   1. Boot embedded postgres on a fixed loopback port.
 *   2. Apply the project's drizzle schema.
 *   3. Deploy Aegis + mocks against the running hardhat node.
 *   4. Open one dispute, fulfill mock VRF, capture the drawn arbiter.
 *   5. Seed the cases + panel_members rows so the UI sees the case
 *      without needing the keeper to index it.
 *   6. Persist all artifact addresses + URLs to e2e/.fixtures.json.
 *   7. Mutate process.env so Playwright's webServer (Next dev) inherits
 *      the right DATABASE_URL + contract addresses.
 *
 * Hardhat is expected to already be running (`pnpm contracts:node` in
 * another terminal). globalSetup hard-fails with a useful message if
 * it isn't.
 */
async function globalSetup(): Promise<void> {
  console.log("[e2e] starting embedded postgres + applying schema…")
  await startEmbeddedPg()

  console.log("[e2e] deploying Aegis + mocks against hardhat…")
  const deployment = await deployFixture()

  console.log("[e2e] wiping DB (clean slate) + seeding the open case…")
  await wipeDb(E2E_DATABASE_URL)
  await seedOpenedCase(E2E_DATABASE_URL, deployment)

  writeFixtures({ databaseUrl: E2E_DATABASE_URL, deployment })

  // The Next dev server inherits these from the playwright process.
  process.env.DATABASE_URL = E2E_DATABASE_URL
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
