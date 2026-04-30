import type { Page } from "@playwright/test"
import { SiweMessage } from "siwe"
import { createWalletClient, http, type Hex } from "viem"
import { hardhat } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"

/**
 * Programmatic SIWE sign-in. Drives the same routes the wallet flow drives
 * (`GET /api/auth/nonce` → `POST /api/auth/verify`) but signs the message in
 * the test process via viem instead of through a browser wallet popup. The
 * resulting iron-session cookie lands on the page's BrowserContext so any
 * subsequent navigation is authenticated.
 *
 * Args:
 *   - page: any Playwright page in the target BrowserContext (only used to
 *           reach the request fixture and the context's cookie jar).
 *   - privateKey: the hardhat key whose address we want signed-in.
 *   - baseURL: where the dev server is reachable. Defaults to the value
 *              Playwright is using for that page.
 */
export async function signInAs(
  page: Page,
  privateKey: Hex,
  baseURL: string = page.url().split("/").slice(0, 3).join("/"),
): Promise<{ address: `0x${string}` }> {
  const account = privateKeyToAccount(privateKey)
  const wallet = createWalletClient({ account, chain: hardhat, transport: http() })

  const nonceRes = await page.request.get(`${baseURL}/api/auth/nonce`)
  if (!nonceRes.ok()) throw new Error(`nonce fetch ${nonceRes.status()}: ${await nonceRes.text()}`)
  const { nonce } = (await nonceRes.json()) as { nonce: string }

  const url = new URL(baseURL)
  const message = new SiweMessage({
    domain: url.host,
    address: account.address,
    statement: "Sign in to Aegis",
    uri: baseURL,
    version: "1",
    chainId: hardhat.id,
    nonce,
    issuedAt: new Date().toISOString(),
  })
  const prepared = message.prepareMessage()
  const signature = await wallet.signMessage({ message: prepared })

  const verifyRes = await page.request.post(`${baseURL}/api/auth/verify`, {
    data: { message: prepared, signature },
  })
  if (!verifyRes.ok())
    throw new Error(`verify ${verifyRes.status()}: ${await verifyRes.text()}`)

  return { address: account.address.toLowerCase() as `0x${string}` }
}

/**
 * Convenience wrapper for non-Playwright callers (e.g., a node-side seeding
 * helper that needs an authenticated session for an API call). Uses fetch
 * + a manually-tracked cookie jar.
 */
export async function signInAsViaFetch(
  privateKey: Hex,
  baseURL: string,
): Promise<{ cookie: string; address: `0x${string}` }> {
  const account = privateKeyToAccount(privateKey)
  const wallet = createWalletClient({ account, chain: hardhat, transport: http() })

  const nonceRes = await fetch(`${baseURL}/api/auth/nonce`)
  const setCookie1 = nonceRes.headers.get("set-cookie") ?? ""
  const { nonce } = (await nonceRes.json()) as { nonce: string }

  const url = new URL(baseURL)
  const message = new SiweMessage({
    domain: url.host,
    address: account.address,
    statement: "Sign in to Aegis",
    uri: baseURL,
    version: "1",
    chainId: hardhat.id,
    nonce,
    issuedAt: new Date().toISOString(),
  })
  const prepared = message.prepareMessage()
  const signature = await wallet.signMessage({ message: prepared })

  const verifyRes = await fetch(`${baseURL}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: setCookie1 },
    body: JSON.stringify({ message: prepared, signature }),
  })
  if (!verifyRes.ok) throw new Error(`verify ${verifyRes.status}: ${await verifyRes.text()}`)
  const cookie = verifyRes.headers.get("set-cookie") ?? setCookie1
  return { cookie, address: account.address.toLowerCase() as `0x${string}` }
}
