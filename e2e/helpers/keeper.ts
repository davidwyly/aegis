import type { Address } from "viem"

import { indexAegisEvents } from "@/lib/keeper/aegis-indexer"

/**
 * Run a single keeper indexer pass against the embedded postgres + the
 * deployed Aegis. Mirrors what `keeperTick` does for the Aegis-side
 * events (CaseOpened / ArbiterDrawn / Committed / Revealed / etc.) —
 * the Vaultra-bridge half of the keeper is skipped here because the
 * test fixture opens disputes directly via the contract.
 *
 * Idempotent: scans from the indexer's cursor row in `indexer_state`,
 * advances the cursor, returns a summary of how many events were
 * applied. Tests should call this AFTER each on-chain mutation that
 * needs to be reflected in the DB-backed UI.
 *
 * Process model: this helper runs in the Playwright test process, which
 * is a plain Node context. The keeper modules used to ship with
 * `import "server-only"`, which threw outside Next's RSC runtime; the
 * directive was dropped (with the rationale captured in CLAUDE.md) so
 * this works directly.
 */
export async function tickKeeper(args: {
  databaseUrl: string
  chainId: number
  rpcUrl: string
  aegisAddress: Address
}): Promise<void> {
  // The keeper reads `process.env.DATABASE_URL` via its drizzle client.
  // Tests run in the same process as globalSetup (which already set
  // DATABASE_URL), so we just confirm and proceed.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = args.databaseUrl
  }
  await indexAegisEvents({
    chainId: args.chainId,
    rpcUrl: args.rpcUrl,
    aegisAddress: args.aegisAddress,
  })
}
