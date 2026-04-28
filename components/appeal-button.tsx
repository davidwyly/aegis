"use client"
import { useState } from "react"
import { useChainId, useWriteContract } from "wagmi"
import { aegisAbi } from "@/lib/abi/aegis"
import { erc20Abi } from "viem"

/**
 * Two-step appeal: approve the bond, then call requestAppeal. Only
 * shown to parties on a case in `appealable_resolved` state.
 */
export function AppealButton({
  aegisAddress,
  caseId,
  bondToken,
  bondAmount,
}: {
  aegisAddress: `0x${string}`
  caseId: `0x${string}`
  bondToken: `0x${string}`
  bondAmount: bigint
}) {
  const chainId = useChainId()
  const { writeContractAsync, isPending } = useWriteContract()
  const [stage, setStage] = useState<"idle" | "approving" | "appealing" | "done">("idle")
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)

  async function go() {
    setError(null)
    try {
      setStage("approving")
      const approveHash = await writeContractAsync({
        address: bondToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [aegisAddress, bondAmount],
        chainId,
      })
      setHash(approveHash)
      setStage("appealing")
      const txHash = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: "requestAppeal",
        args: [caseId],
        chainId,
      })
      setHash(txHash)
      setStage("done")
    } catch (err) {
      setError(err instanceof Error ? err.message : "appeal failed")
      setStage("idle")
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Filing an appeal posts a bond of <code className="font-mono">{bondAmount.toString()}</code>{" "}
        ELCP. If the appeal panel reaches a verdict close to the original
        (within tolerance), the original verdict is upheld and your bond
        pays the appeal panel. If they overturn it, the bond is refunded
        and the original panel is slashed.
      </p>
      <button
        onClick={go}
        disabled={isPending || stage === "approving" || stage === "appealing"}
        className="btn-primary"
      >
        {stage === "approving"
          ? "Approving bond…"
          : stage === "appealing"
            ? "Filing appeal…"
            : stage === "done"
              ? "Appeal filed"
              : "Appeal verdict"}
      </button>
      {hash && (
        <div className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
          tx: {hash.slice(0, 10)}…
        </div>
      )}
      {error && (
        <div className="text-sm text-rose-700 dark:text-rose-300">{error}</div>
      )}
    </div>
  )
}
