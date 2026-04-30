import { test, expect } from "@playwright/test"

import { readFixtures } from "./helpers/fixtures"
import { privateKeyFor } from "./helpers/deploy"
import { injectWallet } from "./helpers/wallet-inject"
import { wipeDb, seedOpenedCase } from "./helpers/db"

/**
 * Drives the SIWE sign-in flow through the UI button rather than the
 * programmatic /api/auth helpers. The injected wallet handles the
 * personal_sign call wagmi makes on the user's behalf.
 *
 * This is mainly a regression check on the SignInButton component +
 * the wagmi `injected` connector + the SIWE verify route, end-to-end.
 */

test.describe("UI sign-in", () => {
  test.beforeEach(async () => {
    const f = readFixtures()
    await wipeDb(f.databaseUrl)
    await seedOpenedCase(f.databaseUrl, f.deployment)
  })

  test("clicking Sign in lands an authenticated session", async ({ page }) => {
    const f = readFixtures()
    const arbiter = f.deployment.seededCase.drawnArbiter
    const privateKey = privateKeyFor(arbiter)

    await injectWallet(page, privateKey, f.deployment.rpcUrl)
    await page.goto("/")

    // Pre-state: the "Sign in" button is visible.
    const signIn = page.getByRole("button", { name: "Sign in" })
    await expect(signIn).toBeVisible()

    await signIn.click()

    // Post-state: the button collapses to "<addr-prefix>… · sign out".
    // 4-char prefix matches the SignInButton component's slice(0,6).
    const truncated = arbiter.slice(0, 6).toLowerCase()
    await expect(
      page.getByRole("button", { name: new RegExp(`${truncated}.*sign out`, "i") }),
    ).toBeVisible({ timeout: 15_000 })

    // Verify /api/auth/me actually says we're signed in as that address.
    const me = await page.request.get("/api/auth/me")
    expect(me.ok()).toBeTruthy()
    const body = (await me.json()) as { address?: string | null }
    expect(body.address?.toLowerCase()).toBe(arbiter.toLowerCase())
  })
})
