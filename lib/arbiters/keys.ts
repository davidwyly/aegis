import "server-only"
import { z } from "zod"
import { eq, inArray } from "drizzle-orm"
import { recoverMessageAddress } from "viem"
import { db, schema } from "@/lib/db/client"
import { REGISTRATION_MESSAGE_V1, pubkeyMatchesSignature } from "@/lib/crypto/seal"

export const pubkeyRegistrationSchema = z.object({
  pubkey: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "32-byte hex"),
  signature: z
    .string()
    .regex(/^0x[a-fA-F0-9]{130}$/, "65-byte hex (secp256k1 signature)"),
})

export type PubkeyRegistration = z.infer<typeof pubkeyRegistrationSchema>

const lower = (a: string) => a.toLowerCase()

export class PubkeyError extends Error {
  constructor(public code: "BAD_SIGNATURE" | "PUBKEY_MISMATCH") {
    super(code)
  }
}

/**
 * Register or update an arbiter's public encryption key. Verifies the
 * signature was produced by the claimed wallet address AND that the
 * pubkey matches what `deriveX25519Keypair(signature)` produces — so
 * an attacker can't post someone else's signature with their own
 * pubkey.
 */
export async function registerPubkey(
  expectedAddress: `0x${string}`,
  input: PubkeyRegistration,
) {
  // Check: signature is from the claimed address.
  const recovered = await recoverMessageAddress({
    message: REGISTRATION_MESSAGE_V1,
    signature: input.signature as `0x${string}`,
  })
  if (lower(recovered) !== lower(expectedAddress)) {
    throw new PubkeyError("BAD_SIGNATURE")
  }
  // Check: claimed pubkey is what the signature deterministically produces.
  if (!pubkeyMatchesSignature(input.pubkey, input.signature)) {
    throw new PubkeyError("PUBKEY_MISMATCH")
  }

  const address = lower(expectedAddress)
  const existing = await db.query.arbiterKeys.findFirst({
    where: eq(schema.arbiterKeys.address, address),
  })
  if (existing) {
    await db
      .update(schema.arbiterKeys)
      .set({
        pubkey: input.pubkey.toLowerCase() as `0x${string}`,
        signature: input.signature.toLowerCase() as `0x${string}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.arbiterKeys.address, address))
    return { updated: true }
  }
  await db.insert(schema.arbiterKeys).values({
    address,
    pubkey: input.pubkey.toLowerCase() as `0x${string}`,
    signature: input.signature.toLowerCase() as `0x${string}`,
  })
  return { updated: false }
}

export async function getPubkey(address: string) {
  return db.query.arbiterKeys.findFirst({
    where: eq(schema.arbiterKeys.address, lower(address)),
  })
}

export async function getPubkeysFor(addresses: readonly string[]) {
  if (addresses.length === 0) return []
  return db.query.arbiterKeys.findMany({
    where: inArray(
      schema.arbiterKeys.address,
      addresses.map(lower),
    ),
  })
}
