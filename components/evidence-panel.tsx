"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import { useAccount, useSignMessage } from "wagmi"
import {
  REGISTRATION_MESSAGE_V1,
  deriveX25519Keypair,
  openBytesForViewer,
  sealBytesForRecipients,
  type SealedKey,
} from "@/lib/crypto/seal"

interface EvidenceItem {
  id: string
  uploaderAddress: string
  role: "partyA" | "partyB"
  fileName: string
  mimeType: string
  size: number
  sha256: string
  uploadedAt: string
  isEncrypted: boolean
  bodyNonce: string | null
  sealedRecipients: SealedKey[] | null
}

const MAX_BYTES = 2 * 1024 * 1024
const ERROR_LABELS: Record<string, string> = {
  CASE_NOT_FOUND: "Case not found.",
  NOT_PARTY: "Only the parties can upload evidence.",
  FILE_TOO_LARGE: "File exceeds the 2 MB limit.",
  MIME_NOT_ALLOWED: "File type not accepted (PDF, image, text, CSV, JSON).",
  FILE_EMPTY: "File is empty.",
  FILENAME_REQUIRED: "Missing filename.",
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function downloadBlob(bytes: Uint8Array, fileName: string, mimeType: string) {
  // Cast through BlobPart — TS's lib.dom narrows Blob input to
  // ArrayBufferView<ArrayBuffer>, but Uint8Array<ArrayBufferLike> is fine
  // at runtime in browsers/Node.
  const blob = new Blob([bytes as unknown as BlobPart], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function EvidencePanel({
  caseId,
  canUpload,
  panelistAddresses,
  authorAddress,
}: {
  caseId: string
  canUpload: boolean
  /** Required for the encrypt path so the file is sealed to the panel + author. */
  panelistAddresses?: string[]
  /** Author's own address — included as a recipient so they can re-download later. */
  authorAddress?: string
}) {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [items, setItems] = useState<EvidenceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [encryptOn, setEncryptOn] = useState(false)
  const [recipientKeys, setRecipientKeys] = useState<{ address: string; pubkey: string }[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const recipientAddresses = useMemo(() => {
    if (!authorAddress || !panelistAddresses) return [] as string[]
    return Array.from(
      new Set([authorAddress, ...panelistAddresses].map((a) => a.toLowerCase())),
    )
  }, [authorAddress, panelistAddresses])

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/cases/${caseId}/evidence`)
      const data = await res.json()
      setItems(data.evidence ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [caseId])

  useEffect(() => {
    if (!encryptOn || recipientAddresses.length === 0) return
    void (async () => {
      try {
        const qs = recipientAddresses.map((a) => `address=${a}`).join("&")
        const res = await fetch(`/api/arbiters/keys?${qs}`)
        const data = await res.json()
        setRecipientKeys(data.keys ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : "key fetch failed")
      }
    })()
  }, [encryptOn, recipientAddresses])

  const missingRecipients = useMemo(() => {
    if (!recipientKeys) return []
    const have = new Set(recipientKeys.map((k) => k.address.toLowerCase()))
    return recipientAddresses.filter((a) => !have.has(a.toLowerCase()))
  }, [recipientKeys, recipientAddresses])

  async function upload(file: File) {
    if (file.size > MAX_BYTES) {
      setError(ERROR_LABELS.FILE_TOO_LARGE)
      return
    }
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      if (encryptOn) {
        if (!recipientKeys) throw new Error("Recipient keys not loaded yet")
        if (missingRecipients.length > 0) {
          throw new Error(
            `Missing pubkey for ${missingRecipients.length} recipient(s). They need to "Configure encryption" on their profile, or upload unencrypted.`,
          )
        }
        const plaintext = new Uint8Array(await file.arrayBuffer())
        const sealed = sealBytesForRecipients(
          plaintext,
          recipientKeys.map((k) => k.pubkey),
        )
        const blob = new Blob([sealed.bodyCiphertext as unknown as BlobPart], {
          type: "application/octet-stream",
        })
        form.append("file", blob, "ciphertext.bin")
        form.append("fileName", file.name)
        form.append("mimeType", file.type)
        form.append("bodyNonce", sealed.bodyNonce)
        form.append("sealedRecipients", JSON.stringify(sealed.recipients))
      } else {
        form.append("file", file)
      }
      const res = await fetch(`/api/cases/${caseId}/evidence`, {
        method: "POST",
        body: form,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(ERROR_LABELS[j.error] ?? j.error ?? `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "upload failed")
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  async function downloadAndDecrypt(it: EvidenceItem) {
    setError(null)
    try {
      const res = await fetch(`/api/cases/${caseId}/evidence/${it.id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const ciphertext = new Uint8Array(await res.arrayBuffer())

      if (!connectedAddress) throw new Error("Connect your wallet to decrypt")
      const cacheKey = `aegis-priv:${connectedAddress.toLowerCase()}`
      let priv = window.localStorage.getItem(cacheKey)
      if (!priv) {
        const sig = await signMessageAsync({ message: REGISTRATION_MESSAGE_V1 })
        priv = deriveX25519Keypair(sig).privateKey
        window.localStorage.setItem(cacheKey, priv)
      }
      const plaintext = openBytesForViewer(
        ciphertext,
        it.bodyNonce ?? "0x",
        it.sealedRecipients ?? [],
        priv,
      )
      downloadBlob(plaintext, it.fileName, it.mimeType)
    } catch (err) {
      setError(err instanceof Error ? err.message : "decrypt failed")
    }
  }

  return (
    <div className="space-y-3">
      {canUpload && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,application/pdf,image/png,image/jpeg,image/webp,text/plain,text/markdown,text/csv,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void upload(f)
              }}
              disabled={uploading}
              className="text-sm"
            />
            <span className="text-xs text-zinc-500">
              PDF, image, text, CSV, JSON · ≤ 2 MB
            </span>
          </div>
          {recipientAddresses.length > 0 && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={encryptOn}
                onChange={(e) => setEncryptOn(e.target.checked)}
              />
              <span>
                Encrypt — only the panel and you can decrypt. Requires every
                recipient to have configured encryption.
              </span>
            </label>
          )}
          {encryptOn && missingRecipients.length > 0 && (
            <div className="text-xs text-amber-700 dark:text-amber-300">
              Missing pubkey for: {missingRecipients.map((a) => a.slice(0, 10) + "…").join(", ")}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-zinc-500">Loading evidence…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-zinc-500">No evidence uploaded yet.</div>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex flex-wrap items-center gap-3 rounded border border-zinc-200 p-2 dark:border-zinc-800"
            >
              {it.isEncrypted ? (
                <button
                  onClick={() => void downloadAndDecrypt(it)}
                  className="font-mono text-sm hover:underline"
                  title="Decrypt and download"
                >
                  🔒 {it.fileName}
                </button>
              ) : (
                <a
                  href={`/api/cases/${caseId}/evidence/${it.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-sm hover:underline"
                >
                  {it.fileName}
                </a>
              )}
              <span className="text-xs text-zinc-500">
                {it.mimeType} · {formatSize(it.size)}
              </span>
              <span className="text-xs text-zinc-500">
                {it.role} · {shortAddr(it.uploaderAddress)}
              </span>
              <span
                className="text-[10px] font-mono text-zinc-400"
                title={`sha256: ${it.sha256}`}
              >
                {it.sha256.slice(0, 10)}…
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
