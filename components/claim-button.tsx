"use client"
import { useState } from "react"
import { useChainId, useWriteContract, useSwitchChain } from "wagmi"
import { aegisAbi } from "@/lib/abi/aegis"
import { formatUnits } from "viem"
import type { SupportedChainId } from "@/lib/chains"

/**
 * Claim pending arbiter fees for a single (chain, token) pair. The
 * contract's pull-pattern `claim(token)` transfers the full claimable
 * balance, so this is a one-shot button — no amount input.
 */
export function ClaimButton({
  chainId,
  aegisAddress,
  token,
  amount,
  tokenSymbol = "TOKEN",
  tokenDecimals = 6,
}: {
  chainId: number
  aegisAddress: `0x${string}`
  token: `0x${string}`
  amount: bigint
  tokenSymbol?: string
  tokenDecimals?: number
}) {
  const activeChainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync, isPending } = useWriteContract()
  const [stage, setStage] = useState<"idle" | "switching" | "claiming" | "done">(
    "idle",
  )
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)

  async function go() {
    setError(null)
    setHash(null)
    try {
      if (activeChainId !== chainId) {
        setStage("switching")
        await switchChainAsync({ chainId: chainId as SupportedChainId })
      }
      setStage("claiming")
      const txHash = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: "claim",
        args: [token],
        chainId: chainId as SupportedChainId,
      })
      setHash(txHash)
      setStage("done")
    } catch (err) {
      setError(err instanceof Error ? err.message : "claim failed")
      setStage("idle")
    }
  }

  const human = formatUnits(amount, tokenDecimals)
  const busy = isPending || stage === "switching" || stage === "claiming"

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        className="btn-primary text-xs"
        onClick={go}
        disabled={busy || amount === 0n || stage === "done"}
      >
        {stage === "switching"
          ? "Switching chain…"
          : stage === "claiming"
            ? "Claiming…"
            : stage === "done"
              ? "Claimed"
              : `Claim ${human} ${tokenSymbol}`}
      </button>
      {hash && (
        <span className="font-mono text-emerald-700 dark:text-emerald-400">
          tx {hash.slice(0, 10)}…
        </span>
      )}
      {error && <span className="text-rose-700 dark:text-rose-300">{error}</span>}
    </div>
  )
}
