import { describe, it, expect } from "vitest"
import {
  deriveX25519Keypair,
  sealForRecipients,
  openForViewer,
  pubkeyMatchesSignature,
  sealBytesForRecipients,
  openBytesForViewer,
} from "./seal"

// Two fixed 65-byte (130-hex-char) secp256k1 signatures, hex. Don't need
// to be valid wallet sigs for unit tests — we're testing the sig-to-key
// derivation + the seal/open round-trip, both of which only care about
// the bytes.
const FIXED_SIG_A =
  "0x" +
  "11".repeat(32) + // r
  "22".repeat(32) + // s
  "1c" // v
const FIXED_SIG_B =
  "0x" +
  "33".repeat(32) +
  "44".repeat(32) +
  "1c"

describe("deriveX25519Keypair", () => {
  it("is deterministic — same signature → same keypair", () => {
    const a = deriveX25519Keypair(FIXED_SIG_A)
    const b = deriveX25519Keypair(FIXED_SIG_A)
    expect(a.publicKey).toEqual(b.publicKey)
    expect(a.privateKey).toEqual(b.privateKey)
  })

  it("different signatures → different keypairs", () => {
    const a = deriveX25519Keypair(FIXED_SIG_A)
    const b = deriveX25519Keypair(FIXED_SIG_B)
    expect(a.publicKey).not.toEqual(b.publicKey)
  })

  it("pubkeyMatchesSignature confirms the derivation", () => {
    const { publicKey } = deriveX25519Keypair(FIXED_SIG_A)
    expect(pubkeyMatchesSignature(publicKey, FIXED_SIG_A)).toBe(true)
    expect(pubkeyMatchesSignature(publicKey, FIXED_SIG_B)).toBe(false)
  })
})

describe("seal / open round-trip", () => {
  it("a recipient can decrypt their own sealed brief", () => {
    const alice = deriveX25519Keypair(FIXED_SIG_A)
    const sealed = sealForRecipients("hello, panel", [alice.publicKey])
    expect(openForViewer(sealed, alice.privateKey)).toEqual("hello, panel")
  })

  it("multiple recipients can each decrypt independently", () => {
    const alice = deriveX25519Keypair(FIXED_SIG_A)
    const bob = deriveX25519Keypair(FIXED_SIG_B)
    const sealed = sealForRecipients("multi-recipient body", [
      alice.publicKey,
      bob.publicKey,
    ])
    expect(openForViewer(sealed, alice.privateKey)).toEqual("multi-recipient body")
    expect(openForViewer(sealed, bob.privateKey)).toEqual("multi-recipient body")
  })

  it("a non-recipient cannot decrypt", () => {
    const alice = deriveX25519Keypair(FIXED_SIG_A)
    const eve = deriveX25519Keypair(FIXED_SIG_B)
    const sealed = sealForRecipients("for alice only", [alice.publicKey])
    expect(() => openForViewer(sealed, eve.privateKey)).toThrow(/No sealed key/)
  })

  it("tampering with the body ciphertext breaks decryption", () => {
    const alice = deriveX25519Keypair(FIXED_SIG_A)
    const sealed = sealForRecipients("integrity check", [alice.publicKey])
    // Flip a byte deep in the ciphertext.
    const tampered = {
      ...sealed,
      bodyCiphertext: ("0x" +
        sealed.bodyCiphertext.slice(2).replace(/^.{4}/, "dead")) as `0x${string}`,
    }
    expect(() => openForViewer(tampered, alice.privateKey)).toThrow()
  })

  it("tampering with the wrapped key breaks decryption", () => {
    const alice = deriveX25519Keypair(FIXED_SIG_A)
    const sealed = sealForRecipients("integrity check", [alice.publicKey])
    const tampered = {
      ...sealed,
      recipients: [
        {
          ...sealed.recipients[0],
          wrapped: ("0x" +
            sealed.recipients[0].wrapped
              .slice(2)
              .replace(/^.{4}/, "feed")) as `0x${string}`,
        },
      ],
    }
    expect(() => openForViewer(tampered, alice.privateKey)).toThrow()
  })
})

describe("seal / open binary round-trip", () => {
  it("a recipient can decrypt arbitrary binary bytes", () => {
    const alice = deriveX25519Keypair(FIXED_SIG_A)
    // Random-ish 1024-byte body; we only care about exact round-trip.
    const body = new Uint8Array(1024)
    for (let i = 0; i < body.length; i++) body[i] = (i * 37 + 13) & 0xff
    const sealed = sealBytesForRecipients(body, [alice.publicKey])
    const out = openBytesForViewer(
      sealed.bodyCiphertext,
      sealed.bodyNonce,
      sealed.recipients,
      alice.privateKey,
    )
    expect(out.length).toEqual(body.length)
    for (let i = 0; i < body.length; i++) expect(out[i]).toEqual(body[i])
  })

  it("multi-recipient binary round-trip", () => {
    const alice = deriveX25519Keypair(FIXED_SIG_A)
    const bob = deriveX25519Keypair(FIXED_SIG_B)
    const body = new Uint8Array([1, 2, 3, 255, 0, 128])
    const sealed = sealBytesForRecipients(body, [alice.publicKey, bob.publicKey])
    for (const v of [alice, bob]) {
      const out = openBytesForViewer(
        sealed.bodyCiphertext,
        sealed.bodyNonce,
        sealed.recipients,
        v.privateKey,
      )
      expect(Array.from(out)).toEqual([1, 2, 3, 255, 0, 128])
    }
  })

  it("a non-recipient cannot decrypt binary", () => {
    const alice = deriveX25519Keypair(FIXED_SIG_A)
    const eve = deriveX25519Keypair(FIXED_SIG_B)
    const sealed = sealBytesForRecipients(new Uint8Array([0x42]), [alice.publicKey])
    expect(() =>
      openBytesForViewer(
        sealed.bodyCiphertext,
        sealed.bodyNonce,
        sealed.recipients,
        eve.privateKey,
      ),
    ).toThrow(/No sealed key/)
  })
})
