"use client"
import { useEffect, useMemo, useState } from "react"
import { useAccount, useSignMessage } from "wagmi"
import {
  REGISTRATION_MESSAGE_V1,
  deriveX25519Keypair,
  openForViewer,
  sealForRecipients,
  type SealedBrief,
} from "@/lib/crypto/seal"

interface ArbiterKey {
  address: string
  pubkey: string
}

export function BriefEditor({
  caseId,
  panelistAddresses,
  authorAddress,
}: {
  caseId: string
  /** Current panelists who should be able to read encrypted briefs. */
  panelistAddresses: string[]
  /** The signed-in party's address, used as a recipient so they can read their own brief later. */
  authorAddress: string
}) {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const [body, setBody] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [encryptOn, setEncryptOn] = useState(false)
  const [keys, setKeys] = useState<ArbiterKey[] | null>(null)
  const [existingEncrypted, setExistingEncrypted] = useState<SealedBrief | null>(null)

  // Address list to look up pubkeys for: panelists + author themselves.
  const recipientAddresses = useMemo(() => {
    const set = new Set<string>(
      [authorAddress, ...panelistAddresses].map((a) => a.toLowerCase()),
    )
    return Array.from(set)
  }, [authorAddress, panelistAddresses])

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/cases/${caseId}/briefs/me`)
        if (res.status === 401) {
          setError("Sign in with the wallet of a party to write a brief.")
          return
        }
        const data = await res.json()
        if (data.brief) {
          if (data.brief.isEncrypted) {
            setEncryptOn(true)
            setExistingEncrypted(data.brief.sealed as SealedBrief)
            // Try to decrypt for editing convenience.
            try {
              const priv = await ensurePrivateKey(authorAddress, signMessageAsync)
              const plaintext = openForViewer(data.brief.sealed, priv)
              setBody(plaintext)
            } catch {
              // Decryption fails silently — author can still re-write the body.
            }
          } else {
            setBody(data.brief.body ?? "")
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "load failed")
      } finally {
        setLoading(false)
      }
    })()
    // signMessageAsync identity is stable across renders within a wagmi session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId])

  // Fetch pubkeys for recipients whenever the encrypt toggle is on.
  useEffect(() => {
    if (!encryptOn) return
    void (async () => {
      try {
        const qs = recipientAddresses.map((a) => `address=${a}`).join("&")
        const res = await fetch(`/api/arbiters/keys?${qs}`)
        const data = await res.json()
        setKeys(data.keys ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : "key fetch failed")
      }
    })()
  }, [encryptOn, recipientAddresses])

  const missingRecipients = useMemo(() => {
    if (!keys) return []
    const have = new Set(keys.map((k) => k.address.toLowerCase()))
    return recipientAddresses.filter((a) => !have.has(a.toLowerCase()))
  }, [keys, recipientAddresses])

  async function save() {
    setSaving(true)
    setError(null)
    try {
      let payload: { body?: string; sealed?: SealedBrief }
      if (encryptOn) {
        if (!keys) throw new Error("Recipient keys not loaded yet")
        if (missingRecipients.length > 0) {
          throw new Error(
            `Missing pubkey for ${missingRecipients.length} recipient(s). They need to "Configure encryption" on their arbiter profile, or you can save unencrypted.`,
          )
        }
        const sealed = sealForRecipients(
          body,
          keys.map((k) => k.pubkey),
        )
        payload = { sealed }
      } else {
        payload = { body }
      }
      const res = await fetch(`/api/cases/${caseId}/briefs/me`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      setSaved(new Date().toLocaleTimeString())
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed")
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="text-sm text-zinc-500">Loading brief…</div>
  if (error && !body && !existingEncrypted)
    return <div className="text-sm text-rose-700 dark:text-rose-300">{error}</div>

  return (
    <div className="space-y-2">
      <textarea
        className="input min-h-[160px] w-full font-mono text-sm"
        value={body}
        maxLength={8000}
        onChange={(e) => setBody(e.target.value)}
        placeholder="State your case. Plain text or Markdown."
      />
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={encryptOn}
          onChange={(e) => setEncryptOn(e.target.checked)}
        />
        <span>
          Encrypt this brief — only the panel and you will be able to read it.
          Requires every recipient to have configured encryption.
        </span>
      </label>
      {encryptOn && missingRecipients.length > 0 && (
        <div className="text-xs text-amber-700 dark:text-amber-300">
          Missing pubkey for: {missingRecipients.map((a) => a.slice(0, 10) + "…").join(", ")}
        </div>
      )}
      <div className="flex items-center gap-3 text-xs">
        <button
          onClick={save}
          disabled={saving || body.trim().length === 0 || (encryptOn && missingRecipients.length > 0)}
          className="btn-primary"
        >
          {saving ? "Saving…" : encryptOn ? "Encrypt + save" : "Save brief"}
        </button>
        <span className="text-zinc-500">{body.length} / 8000</span>
        {saved && <span className="text-emerald-700 dark:text-emerald-400">Saved {saved}</span>}
      </div>
      {error && (
        <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
      )}
      {connectedAddress &&
        connectedAddress.toLowerCase() !== authorAddress.toLowerCase() && (
          <div className="text-xs text-amber-700 dark:text-amber-300">
            Connected wallet ({connectedAddress.slice(0, 10)}…) doesn&apos;t match
            the case party ({authorAddress.slice(0, 10)}…). Switch wallets to
            save.
          </div>
        )}
    </div>
  )
}

/**
 * Ensure the local browser has the X25519 private key for `address`. If
 * not in localStorage, prompts the wallet to sign the registration
 * message and derives the keypair. Result cached for subsequent calls.
 */
async function ensurePrivateKey(
  address: string,
  signMessageAsync: ReturnType<typeof useSignMessage>["signMessageAsync"],
): Promise<string> {
  const key = `aegis-priv:${address.toLowerCase()}`
  const cached = window.localStorage.getItem(key)
  if (cached) return cached
  const sig = await signMessageAsync({ message: REGISTRATION_MESSAGE_V1 })
  const { privateKey } = deriveX25519Keypair(sig)
  window.localStorage.setItem(key, privateKey)
  return privateKey
}
