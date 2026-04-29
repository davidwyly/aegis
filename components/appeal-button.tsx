"use client"
import { useState } from "react"
import { useChainId, useWriteContract } from "wagmi"
import { aegisAbi } from "@/lib/abi/aegis"
import { erc20Abi, formatUnits } from "viem"

/**
 * Two-step appeal request: approve the appeal fee, then call
 * requestAppeal. Only shown to parties on a case in
 * `appealable_resolved` state who are eligible per D12 (the caller
 * is responsible for hiding this for full winners).
 *
 * Under the new design (per docs/arbitration-redesign.md):
 *  - The appeal fee is denominated in the escrow's fee token
 *    (e.g. USDC), NOT in ELCP. ELCP bonds are out.
 *  - There is no upheld / overturned distinction — the appeal
 *    panel's two votes are aggregated with the original arbiter's
 *    vote into a median of 3, and that median IS the verdict.
 *  - The fee is always consumed (D2): the appeal panel + slashing
 *    pool gets it regardless of how the median moves.
 */
export function AppealButton({
  aegisAddress,
  caseId,
  feeToken,
  feeAmount,
  feeTokenSymbol,
  feeTokenDecimals,
}: {
  aegisAddress: `0x${string}`
  caseId: `0x${string}`
  feeToken: `0x${string}`
  feeAmount: bigint
  feeTokenSymbol: string
  feeTokenDecimals: number
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
        address: feeToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [aegisAddress, feeAmount],
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

  const human = formatUnits(feeAmount, feeTokenDecimals)

  return (
    <div className="space-y-2">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Filing an appeal pays{" "}
        <code className="font-mono">
          {human} {feeTokenSymbol}
        </code>{" "}
        (2.5% of the disputed amount). Two additional arbiters are drawn at
        random; the final verdict is the median of all three votes including
        the original. The fee funds the new arbiters&apos; work and is not
        refunded.
      </p>
      <button
        onClick={go}
        disabled={isPending || stage === "approving" || stage === "appealing"}
        className="btn-primary"
      >
        {stage === "approving"
          ? "Approving fee…"
          : stage === "appealing"
            ? "Filing appeal…"
            : stage === "done"
              ? "Appeal filed"
              : `Appeal — pay ${human} ${feeTokenSymbol}`}
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
