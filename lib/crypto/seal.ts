/**
 * Hybrid encryption for briefs.
 *
 * - Body: AES-256-GCM with a random 32-byte key K + 12-byte IV.
 * - Per-recipient: K is sealed to each recipient's X25519 public key
 *   using ECDH(my-ephemeral-priv, recipient-pub) → HKDF-SHA256 → AES-256-GCM(K).
 *
 * This file is environment-agnostic: it runs in browsers and Node.
 * All inputs/outputs are 0x-prefixed hex except where noted.
 *
 * The key-derivation pattern (`deriveX25519Keypair`) computes a stable
 * X25519 keypair from a wallet signature over a canonical message, so
 * any device with the same wallet can re-derive without storing private
 * key material.
 */

import { x25519 } from "@noble/curves/ed25519"
import { gcm } from "@noble/ciphers/aes"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils"

export const REGISTRATION_MESSAGE_V1 = "Aegis encryption key v1"

const HKDF_INFO = new TextEncoder().encode("aegis/seal/v1/aes256gcm")

function ensureHex(s: string): `0x${string}` {
  return (s.startsWith("0x") ? s : `0x${s}`) as `0x${string}`
}

function hex(b: Uint8Array): `0x${string}` {
  return ensureHex(bytesToHex(b))
}

function fromHex(s: string): Uint8Array {
  return hexToBytes(s.replace(/^0x/, ""))
}

/**
 * Deterministically derive an X25519 keypair from a signature. Given the
 * same signed message, the same wallet always produces the same keypair.
 *
 * Caller is responsible for getting the signature client-side via
 * `wagmi`/`viem` (`signMessage(REGISTRATION_MESSAGE_V1)`).
 */
export function deriveX25519Keypair(signatureHex: string): {
  publicKey: `0x${string}`
  privateKey: `0x${string}`
} {
  const sig = fromHex(signatureHex)
  // Hash the signature to a 32-byte X25519 private key. SHA-256 gives a
  // uniformly-random 32-byte string; X25519 clamps internally. Same
  // wallet + same message → same keypair, every time.
  const priv = sha256(sig)
  const pub = x25519.getPublicKey(priv)
  return { publicKey: hex(pub), privateKey: hex(priv) }
}

/**
 * Verify that a pubkey claim is consistent with a signature. The signer
 * recovered from the signature should match the claimed address; the
 * pubkey should match what `deriveX25519Keypair(signature)` produces.
 *
 * The sig-to-address recovery is done by the caller (viem's
 * `recoverMessageAddress`) — this function only verifies the
 * signature → pubkey mapping.
 */
export function pubkeyMatchesSignature(claimedPubkey: string, signatureHex: string): boolean {
  const derived = deriveX25519Keypair(signatureHex)
  return derived.publicKey.toLowerCase() === ensureHex(claimedPubkey).toLowerCase()
}

export interface SealedKey {
  /** 0x-prefixed hex, the recipient's public key (echoed back for client-side lookup). */
  recipientPubkey: `0x${string}`
  /** Ephemeral sender pubkey used in the ECDH for THIS recipient. */
  ephemeralPubkey: `0x${string}`
  /** AES-GCM nonce for the wrapped body key. */
  nonce: `0x${string}`
  /** AES-GCM ciphertext+tag for the body key. */
  wrapped: `0x${string}`
}

export interface SealedBrief {
  /** AES-GCM nonce for the body. */
  bodyNonce: `0x${string}`
  /** AES-GCM ciphertext+tag for the body. */
  bodyCiphertext: `0x${string}`
  /** One sealed-key blob per recipient (panelist + author). */
  recipients: SealedKey[]
}

/**
 * Encrypt a brief body and seal the body key to each recipient's pubkey.
 * `recipientPubkeys` is the list of X25519 public keys (hex) that should
 * be able to decrypt — typically `[author, ...panelists]`.
 */
export function sealForRecipients(
  body: string,
  recipientPubkeys: readonly string[],
): SealedBrief {
  const bodyKey = randomBytes(32)
  const bodyNonce = randomBytes(12)
  const bodyCiphertext = gcm(bodyKey, bodyNonce).encrypt(new TextEncoder().encode(body))

  const recipients = recipientPubkeys.map<SealedKey>((rpkHex) => {
    const recipientPub = fromHex(rpkHex)
    const ephemeralPriv = randomBytes(32)
    const ephemeralPub = x25519.getPublicKey(ephemeralPriv)
    const shared = x25519.getSharedSecret(ephemeralPriv, recipientPub)
    const wrapKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32)
    const wrapNonce = randomBytes(12)
    const wrapped = gcm(wrapKey, wrapNonce).encrypt(bodyKey)
    return {
      recipientPubkey: hex(recipientPub),
      ephemeralPubkey: hex(ephemeralPub),
      nonce: hex(wrapNonce),
      wrapped: hex(wrapped),
    }
  })

  return {
    bodyNonce: hex(bodyNonce),
    bodyCiphertext: hex(bodyCiphertext),
    recipients,
  }
}

/**
 * Decrypt a brief addressed to the viewer. Returns plaintext body if the
 * viewer's keypair successfully unwraps one of the sealed keys; throws
 * otherwise.
 */
export function openForViewer(brief: SealedBrief, viewerPrivateKey: string): string {
  const myPriv = fromHex(viewerPrivateKey)
  const myPub = x25519.getPublicKey(myPriv)
  const myPubHex = hex(myPub).toLowerCase()

  const slot = brief.recipients.find(
    (r) => r.recipientPubkey.toLowerCase() === myPubHex,
  )
  if (!slot) throw new Error("No sealed key for this viewer")

  const ephemeralPub = fromHex(slot.ephemeralPubkey)
  const shared = x25519.getSharedSecret(myPriv, ephemeralPub)
  const wrapKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32)
  const bodyKey = gcm(wrapKey, fromHex(slot.nonce)).decrypt(fromHex(slot.wrapped))
  const bodyBytes = gcm(bodyKey, fromHex(brief.bodyNonce)).decrypt(
    fromHex(brief.bodyCiphertext),
  )
  return new TextDecoder().decode(bodyBytes)
}

// re-export for callers that need raw curve ops
export { x25519 }
