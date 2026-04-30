import { stopEmbeddedPg } from "./helpers/pg"

/**
 * Playwright `globalTeardown`. Stops the embedded postgres cluster — the
 * non-persistent flag ensures the data dir is wiped automatically. Hardhat
 * is intentionally NOT torn down here: the user is expected to have started
 * it in another terminal, and we don't own its lifecycle.
 */
export default async function globalTeardown(): Promise<void> {
  await stopEmbeddedPg()
}
