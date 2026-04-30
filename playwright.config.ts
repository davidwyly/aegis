import { defineConfig } from "@playwright/test"

/**
 * Playwright config — two test groups:
 *
 *   - smoke.spec.ts: route-level chrome screenshots, no DB / chain.
 *   - arbiter-happy-path.spec.ts: full integration. Requires `pnpm
 *     contracts:node` running in another terminal. globalSetup boots an
 *     embedded postgres, deploys Aegis + mocks, opens a case, fulfills
 *     mock VRF, and seeds the DB. The dev server picks up the embedded
 *     DATABASE_URL via env (passed through from the playwright process).
 *
 * Both groups share the same dev server. Screenshots and report artifacts
 * land under `e2e/`.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./e2e/report" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // Integration tests share a single DB; serialize to keep state predictable.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:3457",
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: "on",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3457",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Inherit DATABASE_URL + NEXT_PUBLIC_* from the playwright process,
    // populated by globalSetup before the webServer is started.
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      NEXT_PUBLIC_AEGIS_HARDHAT: process.env.NEXT_PUBLIC_AEGIS_HARDHAT ?? "",
      NEXT_PUBLIC_VAULTRA_ADAPTER_HARDHAT:
        process.env.NEXT_PUBLIC_VAULTRA_ADAPTER_HARDHAT ?? "",
      NEXT_PUBLIC_ELCP_HARDHAT: process.env.NEXT_PUBLIC_ELCP_HARDHAT ?? "",
      NEXT_PUBLIC_USDC_HARDHAT: process.env.NEXT_PUBLIC_USDC_HARDHAT ?? "",
      NEXT_PUBLIC_HARDHAT_RPC_URL: process.env.NEXT_PUBLIC_HARDHAT_RPC_URL ?? "",
      SESSION_PASSWORD: process.env.SESSION_PASSWORD ?? "",
    },
  },
})
