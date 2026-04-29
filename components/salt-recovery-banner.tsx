"use client"
import { useEffect, useState } from "react"
import { useAccount } from "wagmi"

/**
 * Sticky-bottom red banner shown to an arbiter who has just committed
 * but hasn't yet acknowledged saving their salt recovery file.
 *
 * Why this is a high-stakes UX: the salt is generated client-side at
 * commit time and stashed in localStorage so the same browser can
 * reveal later. If the arbiter clears storage / loses the device /
 * switches browsers BEFORE revealing, they cannot reveal their vote
 * and will be slashed for non-reveal. The recovery file is a JSON
 * the arbiter can re-import on another device.
 *
 * Banner is gated by two localStorage flags:
 *  - `aegis-vote:{caseId}:{address}` — the commit stash itself
 *    (written by CommitRevealForm.commit()). Banner shows only
 *    if this exists, since otherwise there's nothing to back up.
 *  - `aegis-vote-acked:{caseId}:{address}` — set when the user
 *    clicks "I have saved it". Banner hides while this is set.
 *
 * Banner is intentionally loud — red, persistent, sticky to the
 * bottom of the viewport. Don't soften it.
 */
export function SaltRecoveryBanner({
  aegisAddress,
  caseId,
}: {
  aegisAddress: `0x${string}`
  caseId: `0x${string}`
}) {
  const { address } = useAccount()
  const [stash, setStash] = useState<{
    pct: number
    salt: string
    rationale: string
  } | null>(null)
  const [acked, setAcked] = useState(false)

  useEffect(() => {
    if (!address) {
      setStash(null)
      return
    }
    const key = `aegis-vote:${caseId}:${address.toLowerCase()}`
    const ackKey = `aegis-vote-acked:${caseId}:${address.toLowerCase()}`
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      setStash(null)
      return
    }
    try {
      setStash(JSON.parse(raw))
      setAcked(window.localStorage.getItem(ackKey) === "1")
    } catch {
      setStash(null)
    }
  }, [address, caseId])

  if (!address || !stash || acked) return null

  function downloadRecovery() {
    if (!stash || !address) return
    const payload = {
      version: 1,
      kind: "aegis-vote-recovery",
      aegisAddress,
      caseId,
      arbiter: address,
      partyAPercentage: stash.pct,
      salt: stash.salt,
      rationale: stash.rationale,
      generatedAt: new Date().toISOString(),
      note:
        "Keep this file safe. If you lose access to your browser before " +
        "revealing your vote, import this file on another device using " +
        "the same wallet to recover your salt. Without it, you cannot " +
        "reveal and your stake bond will be slashed.",
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `aegis-vote-recovery-${caseId.slice(2, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function acknowledge() {
    if (!address) return
    const ackKey = `aegis-vote-acked:${caseId}:${address.toLowerCase()}`
    window.localStorage.setItem(ackKey, "1")
    setAcked(true)
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-rose-700 bg-rose-600 text-white shadow-lg dark:bg-rose-700">
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm leading-tight">
          <strong className="block font-semibold uppercase tracking-wide">
            Save your salt recovery file — do not skip
          </strong>
          <span className="opacity-90">
            You committed your vote. If you lose this browser before
            revealing, you cannot reveal — and your stake bond will be
            slashed.
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            onClick={downloadRecovery}
            className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50"
          >
            Download recovery file
          </button>
          <button
            onClick={acknowledge}
            className="rounded-md border border-white/40 px-3 py-1.5 text-sm font-medium text-white hover:bg-white/10"
          >
            ✓ I have saved it
          </button>
        </div>
      </div>
    </div>
  )
}
