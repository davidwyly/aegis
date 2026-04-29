import { test, expect } from "@playwright/test"

/**
 * v1 smoke: visit each public route and capture a full-page
 * screenshot. Doesn't seed a case (would require live DB + chain),
 * so the case-workspace screenshot is intentionally not in this
 * suite. Pages with DB dependencies will render their empty / error
 * state, which is fine for a visual sanity check of the chrome.
 */

const ROUTES: Array<{ path: string; name: string }> = [
  { path: "/", name: "home" },
  { path: "/cases", name: "cases-ledger" },
  { path: "/arbiters", name: "arbiters-roster" },
  { path: "/governance", name: "governance" },
  { path: "/queue", name: "my-queue" },
  { path: "/admin", name: "admin-ops" },
]

for (const route of ROUTES) {
  test(`renders ${route.path}`, async ({ page }) => {
    await page.goto(route.path, { waitUntil: "domcontentloaded" })
    // Wait for the top nav wordmark to confirm the layout mounted.
    await expect(page.getByRole("link", { name: "Aegis" }).first()).toBeVisible()
    // Brief settle for any client-side hydration.
    await page.waitForTimeout(500)
    await page.screenshot({
      path: `e2e/__screenshots__/${route.name}.png`,
      fullPage: true,
    })
  })
}
