"use client"
import { useEffect, useMemo, useState } from "react"
import { useAccount, useChainId, useWriteContract } from "wagmi"
import { encodeAbiParameters, keccak256, toHex } from "viem"
import { aegisAbi } from "@/lib/abi/aegis"

/**
 * Commit-reveal form for an arbiter casting a vote on a case.
 *
 * Per de novo (the design doc's blindness property), this form is
 * phase-agnostic. The same `commitVote` and `revealVote` functions
 * handle the original arbiter and either appeal-slot arbiter; the
 * contract routes internally by msg.sender.
 *
 * No "appeal" / "panel" / "round" copy in the user-facing strings.
 *
 * Commit-phase shape: range slider 0..100 to Party A (with party
 * labels at both ends per UX invariant #5), salt field, rationale.
 * Reveal-phase shape: replay from localStorage stash if present,
 * else accept a pasted recovery file (UX invariant #2 fallback).
 */
export function CommitRevealForm({
  aegisAddress,
  caseId,
  phase,
}: {
  aegisAddress: `0x${string}`
  caseId: `0x${string}`
  phase: "commit" | "reveal" | "closed"
}) {
  const { address } = useAccount()
  const chainId = useChainId()
  const { writeContractAsync, isPending } = useWriteContract()

  const [pct, setPct] = useState<number>(50)
  const [salt, setSalt] = useState<string>(() =>
    typeof crypto !== "undefined"
      ? toHex(crypto.getRandomValues(new Uint8Array(32)))
      : "0x" + "a".repeat(64),
  )
  const [rationale, setRationale] = useState("")
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reveal-phase stash — populated either from localStorage on mount
  // or from a pasted recovery file. Kept separate from the commit-
  // phase state so a re-render or paste doesn't disturb the in-flight
  // commit form.
  const [revealStash, setRevealStash] = useState<{
    pct: number
    salt: string
    rationale: string
  } | null>(null)
  const [pasted, setPasted] = useState("")
  const [pasteError, setPasteError] = useState<string | null>(null)

  useEffect(() => {
    if (phase !== "reveal" || !address) return
    const raw = window.localStorage.getItem(
      `aegis-vote:${caseId}:${address.toLowerCase()}`,
    )
    if (!raw) return
    try {
      setRevealStash(JSON.parse(raw))
    } catch {
      // bad json — ignore, fall through to paste UI
    }
  }, [phase, address, caseId])

  // Live commit hash for the current draft. Must match Aegis.hashVote on-chain
  // so the arbiter can sanity-check what they're about to submit. Returns
  // `null` if the salt isn't a parseable 32-byte hex (which would fail at
  // the contract anyway).
  const commitHash = useMemo<`0x${string}` | null>(() => {
    if (!address) return null
    if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) return null
    try {
      const rationaleDigest = keccak256(toHex(rationale))
      const packed = encodeAbiParameters(
        [
          { type: "address" },
          { type: "bytes32" },
          { type: "uint16" },
          { type: "bytes32" },
          { type: "bytes32" },
        ],
        [address, caseId, pct, salt as `0x${string}`, rationaleDigest],
      )
      return keccak256(packed)
    } catch {
      return null
    }
  }, [address, caseId, pct, salt, rationale])

  function downloadRecovery() {
    if (!address || !commitHash) return
    const payload = {
      version: 1,
      kind: "aegis-vote-recovery",
      aegisAddress,
      caseId,
      arbiter: address,
      partyAPercentage: pct,
      salt,
      rationale,
      commitHash,
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
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function commit() {
    if (!address || !commitHash) return
    setError(null)
    try {
      const hash = commitHash

      const tx = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: "commitVote",
        args: [caseId, hash],
        chainId,
      })
      setStatus(`Commit submitted: ${tx.slice(0, 10)}…`)
      // Stash salt + pct in localStorage so reveal can look them up.
      // Critical: if this stash is lost the arbiter cannot reveal and
      // will be slashed for non-reveal. The case workspace also offers
      // a downloadable recovery file alongside this localStorage stash.
      window.localStorage.setItem(
        `aegis-vote:${caseId}:${address.toLowerCase()}`,
        JSON.stringify({ pct, salt, rationale }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "commit failed")
    }
  }

  async function reveal() {
    if (!address || !revealStash) return
    setError(null)
    try {
      const rationaleDigest = keccak256(toHex(revealStash.rationale))
      const tx = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: "revealVote",
        args: [
          caseId,
          revealStash.pct,
          revealStash.salt as `0x${string}`,
          rationaleDigest,
        ],
        chainId,
      })
      setStatus(`Reveal submitted: ${tx.slice(0, 10)}…`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "reveal failed")
    }
  }

  function loadFromPaste() {
    setPasteError(null)
    try {
      const parsed = JSON.parse(pasted) as Record<string, unknown>
      // Accept two shapes: the localStorage stash `{pct, salt, rationale}`
      // or the downloaded recovery file from SaltRecoveryBanner, which
      // uses `partyAPercentage` instead of `pct`.
      const pct = (parsed.pct ?? parsed.partyAPercentage) as
        | number
        | undefined
      const salt = parsed.salt as string | undefined
      const rationale = (parsed.rationale ?? "") as string
      if (typeof pct !== "number" || !salt) {
        setPasteError("Recovery file is missing pct / salt.")
        return
      }
      const stash = { pct, salt, rationale }
      setRevealStash(stash)
      // Restore localStorage so subsequent renders skip the paste UI.
      if (address) {
        window.localStorage.setItem(
          `aegis-vote:${caseId}:${address.toLowerCase()}`,
          JSON.stringify(stash),
        )
      }
    } catch {
      setPasteError("Couldn't parse JSON. Paste the full recovery file.")
    }
  }

  async function recuse() {
    if (!address) return
    setError(null)
    try {
      const tx = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: "recuse",
        args: [caseId],
        chainId,
      })
      setStatus(`Recusal submitted: ${tx.slice(0, 10)}…`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "recuse failed")
    }
  }

  if (phase === "closed")
    return (
      <div className="text-sm text-zinc-500">
        Voting windows have closed. Anyone can call{" "}
        <code>finalize(caseId)</code> on Aegis.
      </div>
    )

  return (
    <div className="space-y-3">
      {phase === "commit" ? (
        <>
          <div>
            <p className="text-xs text-zinc-500">
              Your verdict — share to Party A / Party B
            </p>
            <div className="mt-2 flex items-center gap-3">
              <input
                type="number"
                min={0}
                max={100}
                value={pct}
                onChange={(e) =>
                  setPct(
                    Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                  )
                }
                aria-label="Percentage to Party A"
                className="input w-16 text-center font-mono"
              />
              <input
                type="range"
                min={0}
                max={100}
                value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
                aria-label="Slider — Party A share"
                className="flex-1 accent-zinc-700 dark:accent-zinc-300"
              />
              <input
                type="number"
                min={0}
                max={100}
                value={100 - pct}
                onChange={(e) => {
                  const b = Math.max(0, Math.min(100, Number(e.target.value) || 0))
                  setPct(100 - b)
                }}
                aria-label="Percentage to Party B"
                className="input w-16 text-center font-mono"
              />
            </div>
            <div className="mt-1 flex justify-between text-[10px] font-medium uppercase tracking-wider text-zinc-500">
              <span>All A</span>
              <span>All B</span>
            </div>
          </div>

          <label className="block text-sm">
            <span className="block text-xs text-zinc-500">Salt (hex)</span>
            <input
              value={salt}
              onChange={(e) => setSalt(e.target.value)}
              className="input mt-1 w-full font-mono text-xs"
            />
          </label>

          <label className="block text-sm">
            <span className="block text-xs text-zinc-500">
              Rationale (kept off-chain; only its hash is committed)
            </span>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              className="input mt-1 min-h-[100px] w-full text-sm"
              placeholder="Why party A should receive this share."
            />
          </label>

          <div>
            <p className="text-xs text-zinc-500">
              Secret commitment (kept off-chain; only this hash is sent)
            </p>
            <p className="mt-1 break-all rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              {commitHash ?? "—"}
            </p>
          </div>

          {/* Pre-submit salt-recovery CTA. The post-commit sticky banner
              (SaltRecoveryBanner) still nags after submit, but losing the
              salt before reveal is irreversible — better to download
              before the tx lands. */}
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs dark:border-amber-700/60 dark:bg-amber-900/20">
            <p className="font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
              Save your salt recovery file
            </p>
            <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
              If you lose this browser before revealing, you cannot reveal
              and your stake bond will be slashed. Re-download if you edit
              the salt, percentage, or rationale.
            </p>
            <button
              onClick={downloadRecovery}
              disabled={!commitHash}
              className="btn-secondary mt-2 text-xs"
            >
              Generate &amp; download recovery file
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={commit}
              disabled={isPending || !commitHash}
              className="btn-primary"
            >
              {isPending ? "Submitting…" : "Commit vote"}
            </button>
            <button
              onClick={recuse}
              disabled={isPending}
              className="btn-secondary"
            >
              Recuse (conflict of interest)
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Recusing releases your stake-lock and draws a replacement
            arbiter. Only allowed before you commit.
          </p>
        </>
      ) : revealStash ? (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Your committed verdict was{" "}
            <span className="font-mono">
              {revealStash.pct} / {100 - revealStash.pct}
            </span>
            . Revealing replays the salt + vote on-chain.
          </p>
          <details className="text-xs text-zinc-500">
            <summary className="cursor-pointer hover:underline">
              Show stashed salt
            </summary>
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono">
              {revealStash.salt}
            </pre>
          </details>
          <button onClick={reveal} disabled={isPending} className="btn-primary">
            {isPending ? "Submitting…" : "Reveal vote"}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            No commit stash found in this browser. Paste the recovery
            file you downloaded after committing on another device.
          </p>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            className="input min-h-[120px] w-full font-mono text-xs"
            placeholder='{"version":1,"kind":"aegis-vote-recovery", ...}'
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={loadFromPaste}
              disabled={!pasted}
              className="btn-primary"
            >
              Load recovery file
            </button>
          </div>
          {pasteError && (
            <div className="text-xs text-rose-700 dark:text-rose-300">
              {pasteError}
            </div>
          )}
        </>
      )}
      {status && (
        <div className="text-xs text-emerald-700 dark:text-emerald-400">
          {status}
        </div>
      )}
      {error && (
        <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
      )}
    </div>
  )
}
