"use client"
import { useState } from "react"
import { useAccount, useChainId, useWriteContract } from "wagmi"
import { keccak256, toHex } from "viem"
import { aegisAbi } from "@/lib/abi/aegis"

export function CommitRevealForm({
  aegisAddress,
  caseId,
  phase,
  track = "original",
}: {
  aegisAddress: `0x${string}`
  caseId: `0x${string}`
  phase: "commit" | "reveal" | "closed"
  /** Which contract function to call. Defaults to original-panel functions. */
  track?: "original" | "appeal"
}) {
  const COMMIT_FN = track === "appeal" ? "appealCommitVote" : "commitVote"
  const REVEAL_FN = track === "appeal" ? "appealRevealVote" : "revealVote"
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

  async function commit() {
    if (!address) return
    setError(null)
    try {
      const rationaleDigest = keccak256(toHex(rationale))
      // Compute commit hash with viem — must match Aegis.hashVote on-chain.
      const { encodeAbiParameters } = await import("viem")
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
      const hash = keccak256(packed)

      const tx = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: COMMIT_FN,
        args: [caseId, hash],
        chainId,
      })
      setStatus(`Commit submitted: ${tx.slice(0, 10)}…`)
      // Stash salt + pct in localStorage so reveal can look them up.
      window.localStorage.setItem(
        `aegis-vote:${caseId}:${address.toLowerCase()}`,
        JSON.stringify({ pct, salt, rationale }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "commit failed")
    }
  }

  async function reveal() {
    if (!address) return
    setError(null)
    try {
      const stash = window.localStorage.getItem(
        `aegis-vote:${caseId}:${address.toLowerCase()}`,
      )
      if (!stash) throw new Error("No commit stashed locally; cannot reveal without salt")
      const parsed = JSON.parse(stash) as {
        pct: number
        salt: `0x${string}`
        rationale: string
      }
      const rationaleDigest = keccak256(toHex(parsed.rationale))
      const tx = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: REVEAL_FN,
        args: [caseId, parsed.pct, parsed.salt, rationaleDigest],
        chainId,
      })
      setStatus(`Reveal submitted: ${tx.slice(0, 10)}…`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "reveal failed")
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
        Voting windows have closed. Anyone can call <code>finalize(caseId)</code> on Aegis.
      </div>
    )

  return (
    <div className="space-y-3">
      {phase === "commit" ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              <span className="block text-xs text-zinc-500">Party A %</span>
              <input
                type="number"
                min={0}
                max={100}
                value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
                className="input mt-1 w-full"
              />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-zinc-500">Salt (hex)</span>
              <input
                value={salt}
                onChange={(e) => setSalt(e.target.value)}
                className="input mt-1 w-full font-mono text-xs"
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="block text-xs text-zinc-500">Rationale (kept off-chain; only its hash is committed)</span>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              className="input mt-1 min-h-[100px] w-full text-sm"
              placeholder="Why party A should receive this share."
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button onClick={commit} disabled={isPending} className="btn-primary">
              {isPending ? "Submitting…" : "Commit vote"}
            </button>
            <button onClick={recuse} disabled={isPending} className="btn-secondary">
              Recuse (conflict of interest)
            </button>
          </div>
          <p className="text-xs text-zinc-500">
            Recusing releases your stake-lock and draws a replacement
            panelist. Only allowed before you commit.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Reveal phase. Your salt + vote were stashed in this browser when
            you committed; revealing replays them on-chain.
          </p>
          <button onClick={reveal} disabled={isPending} className="btn-primary">
            {isPending ? "Submitting…" : "Reveal vote"}
          </button>
        </>
      )}
      {status && <div className="text-xs text-emerald-700 dark:text-emerald-400">{status}</div>}
      {error && <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>}
    </div>
  )
}
