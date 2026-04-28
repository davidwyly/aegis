"use client"
import { useState } from "react"
import { useAccount, useSignMessage } from "wagmi"
import {
  REGISTRATION_MESSAGE_V1,
  deriveX25519Keypair,
  openForViewer,
  type SealedBrief,
} from "@/lib/crypto/seal"

/**
 * Reader for an encrypted brief. Tries the cached priv-key in
 * localStorage first; if missing, prompts the user to sign the
 * registration message to derive their keypair. Decryption happens
 * entirely client-side — the server never sees plaintext.
 */
export function EncryptedBriefViewer({
  sealed,
}: {
  sealed: SealedBrief
}) {
  const { address: connectedAddress, isConnected } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function decrypt() {
    setBusy(true)
    setError(null)
    try {
      if (!connectedAddress) {
        throw new Error("Connect your wallet first")
      }
      const cacheKey = `aegis-priv:${connectedAddress.toLowerCase()}`
      let priv = window.localStorage.getItem(cacheKey)
      if (!priv) {
        const sig = await signMessageAsync({ message: REGISTRATION_MESSAGE_V1 })
        priv = deriveX25519Keypair(sig).privateKey
        window.localStorage.setItem(cacheKey, priv)
      }
      const text = openForViewer(sealed, priv)
      setPlaintext(text)
    } catch (err) {
      setError(err instanceof Error ? err.message : "decrypt failed")
    } finally {
      setBusy(false)
    }
  }

  if (plaintext !== null) {
    return (
      <pre className="mt-1 whitespace-pre-wrap text-sm">{plaintext}</pre>
    )
  }

  return (
    <div className="mt-1 space-y-2">
      <p className="text-xs italic text-zinc-500">
        🔒 Encrypted brief.{" "}
        {isConnected
          ? "Decrypt with your wallet to read."
          : "Connect a wallet that's a recipient (panelist or party) to decrypt."}
      </p>
      <button
        onClick={decrypt}
        disabled={busy || !isConnected}
        className="btn-secondary text-xs"
      >
        {busy ? "Decrypting…" : "Decrypt"}
      </button>
      {error && (
        <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
      )}
    </div>
  )
}
