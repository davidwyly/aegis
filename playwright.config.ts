import { defineConfig } from "@playwright/test"

/**
 * Playwright config for visual smoke checks. The app's case workspace
 * needs a live DB + chain to render fully; for the v1 smoke we hit
 * the routes that don't depend on backend state (Home, Cases ledger
 * empty state, Arbiters roster empty state, Governance calldata
 * builder, About-style routes). Screenshots land under `e2e/__screenshots__/`.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./e2e/report" }]],
  use: {
    baseURL: "http://127.0.0.1:3457",
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: "on",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3457",
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
