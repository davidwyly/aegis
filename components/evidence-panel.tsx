"use client"
import { useEffect, useRef, useState } from "react"

interface EvidenceItem {
  id: string
  uploaderAddress: string
  role: "partyA" | "partyB"
  fileName: string
  mimeType: string
  size: number
  sha256: string
  uploadedAt: string
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

export function EvidencePanel({
  caseId,
  canUpload,
}: {
  caseId: string
  canUpload: boolean
}) {
  const [items, setItems] = useState<EvidenceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

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

  async function upload(file: File) {
    if (file.size > MAX_BYTES) {
      setError(ERROR_LABELS.FILE_TOO_LARGE)
      return
    }
    setUploading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append("file", file)
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

  return (
    <div className="space-y-3">
      {canUpload && (
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
              <a
                href={`/api/cases/${caseId}/evidence/${it.id}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-sm hover:underline"
              >
                {it.fileName}
              </a>
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
