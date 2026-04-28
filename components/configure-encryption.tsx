"use client"
import { useEffect, useState } from "react"
import { useAccount, useSignMessage } from "wagmi"
import { REGISTRATION_MESSAGE_V1, deriveX25519Keypair } from "@/lib/crypto/seal"

interface RegisteredKey {
  address: string
  pubkey: string
  registeredAt: string
}

/**
 * "Configure encryption" widget. Visible to the signed-in arbiter on
 * their own profile. Signs the canonical registration message,
 * derives the X25519 keypair, posts the pubkey to the server, and
 * stashes the resulting private key in localStorage so subsequent
 * decryptions can re-derive without prompting again.
 */
export function ConfigureEncryption({ ownerAddress }: { ownerAddress: string }) {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [existing, setExisting] = useState<RegisteredKey | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const isOwner =
    connectedAddress &&
    connectedAddress.toLowerCase() === ownerAddress.toLowerCase()

  useEffect(() => {
    void fetch("/api/arbiters/me/pubkey")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) => setExisting(data.pubkey ?? null))
      .catch(() => setExisting(null))
  }, [])

  async function configure() {
    if (busy) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const signature = await signMessageAsync({ message: REGISTRATION_MESSAGE_V1 })
      const { publicKey, privateKey } = deriveX25519Keypair(signature)

      // Stash private key locally so the same browser can decrypt without
      // re-prompting the wallet. Other devices re-derive the same way.
      window.localStorage.setItem(
        `aegis-priv:${ownerAddress.toLowerCase()}`,
        privateKey,
      )

      const res = await fetch("/api/arbiters/me/pubkey", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pubkey: publicKey, signature }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      setStatus("Encryption configured.")
      setExisting({
        address: ownerAddress.toLowerCase(),
        pubkey: publicKey,
        registeredAt: new Date().toISOString(),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "configure failed")
    } finally {
      setBusy(false)
    }
  }

  if (existing === undefined) return <div className="text-sm text-zinc-500">Loading…</div>

  return (
    <div className="space-y-2">
      {existing ? (
        <div className="text-sm">
          <span className="text-zinc-500">Public key:</span>{" "}
          <span className="font-mono text-xs">{existing.pubkey}</span>
          <div className="text-xs text-zinc-500">
            Registered {new Date(existing.registeredAt).toLocaleString()}
          </div>
        </div>
      ) : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Encryption is not yet configured for this arbiter. Configure to
          let parties seal encrypted briefs to you.
        </p>
      )}
      {isOwner && (
        <button onClick={configure} disabled={busy} className="btn-primary">
          {busy
            ? "Signing…"
            : existing
              ? "Re-configure (sign again)"
              : "Configure encryption"}
        </button>
      )}
      {!isOwner && !existing && (
        <p className="text-xs text-zinc-500">
          Only the arbiter themselves can register a key. They need to sign
          in here and click the button.
        </p>
      )}
      {status && (
        <div className="text-xs text-emerald-700 dark:text-emerald-400">{status}</div>
      )}
      {error && <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>}
    </div>
  )
}
