import "server-only"
import { SiweMessage, generateNonce } from "siwe"
import { eq, and, isNull, lt } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"

export const NONCE_TTL_MS = 10 * 60 * 1000 // 10 minutes

export function assertNonceFresh(
  row: { issuedAt: Date } | undefined,
  now: Date = new Date(),
): void {
  if (!row) throw new Error("Unknown or already-consumed nonce")
  if (now.getTime() - row.issuedAt.getTime() > NONCE_TTL_MS) {
    throw new Error("Nonce expired")
  }
}

export async function issueNonce(): Promise<string> {
  const nonce = generateNonce()
  await db.insert(schema.siweNonces).values({ nonce })
  await db
    .delete(schema.siweNonces)
    .where(lt(schema.siweNonces.issuedAt, new Date(Date.now() - 60 * 60 * 1000)))
  return nonce
}

export async function verifySiwe(
  message: string,
  signature: string,
): Promise<{ address: `0x${string}`; chainId: number }> {
  const siwe = new SiweMessage(message)

  const [consumed] = await db
    .update(schema.siweNonces)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(schema.siweNonces.nonce, siwe.nonce),
        isNull(schema.siweNonces.consumedAt),
      ),
    )
    .returning()
  assertNonceFresh(consumed)

  const expectedDomain = new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3457",
  ).host

  const result = await siwe.verify({
    signature,
    domain: expectedDomain,
    nonce: siwe.nonce,
  })

  if (!result.success) throw new Error("Signature verification failed")

  return {
    address: siwe.address.toLowerCase() as `0x${string}`,
    chainId: siwe.chainId,
  }
}
