"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"

interface Failure {
  id: string
  chainId: number
  vaultraAddress: string
  escrowId: string
  milestoneIndex: string
  noMilestone: boolean
  reason: string
  attempts: number
  firstSeen: string
  lastAttempted: string
}

function shortAddr(a: string) {
  return `${a.slice(0, 8)}…${a.slice(-4)}`
}

function shortHex(h: string) {
  return `${h.slice(0, 12)}…${h.slice(-6)}`
}

export function AdminFailureRow({ failure }: { failure: Failure }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function resolve() {
    if (busy) return
    if (
      !confirm(
        `Mark this failure as resolved? Use only after confirming the dispute was opened by another keeper or the underlying escrow was cancelled.`,
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/failures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: failure.id, action: "resolve" }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "resolve failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr className="border-t border-zinc-200 align-top dark:border-zinc-800">
      <td className="py-2 pr-4 text-xs">{failure.chainId}</td>
      <td className="py-2 pr-4 font-mono text-xs">
        {shortAddr(failure.vaultraAddress)}
      </td>
      <td className="py-2 pr-4 font-mono text-xs">
        {shortHex(failure.escrowId)}
      </td>
      <td className="py-2 pr-4 text-xs">
        {failure.noMilestone ? "(none)" : failure.milestoneIndex}
      </td>
      <td className="py-2 pr-4 text-right font-mono text-xs">
        {failure.attempts}
      </td>
      <td className="py-2 pr-4 text-xs">
        {new Date(failure.lastAttempted).toLocaleString()}
      </td>
      <td className="py-2 pr-4 text-xs">
        <span className="break-all" title={failure.reason}>
          {failure.reason.length > 120
            ? `${failure.reason.slice(0, 120)}…`
            : failure.reason}
        </span>
        {error && (
          <div className="mt-1 text-rose-700 dark:text-rose-300">{error}</div>
        )}
      </td>
      <td className="py-2 text-right">
        <button
          onClick={resolve}
          disabled={busy}
          className="btn-secondary text-xs"
        >
          {busy ? "Resolving…" : "Mark resolved"}
        </button>
      </td>
    </tr>
  )
}
