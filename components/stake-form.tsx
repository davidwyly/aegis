"use client"
import { useState } from "react"
import { useChainId, useWriteContract, useSwitchChain } from "wagmi"
import { erc20Abi, parseUnits, formatUnits } from "viem"
import { aegisAbi } from "@/lib/abi/aegis"
import type { SupportedChainId } from "@/lib/chains"

/**
 * Stake / unstake against a single Aegis instance on a single chain.
 * ELCP is the only stake token. Approve flow is bundled into Stake;
 * Unstake is a direct call that the contract guards with the locked-
 * stake invariant (StakeLocked revert if free stake would dip below 0).
 *
 * The component is rendered server-side with current on-chain state
 * passed in as props (staked / locked / free). Submitting a tx triggers
 * a chain switch when the wallet's active chain doesn't match.
 */
export function StakeForm({
  chainId,
  aegisAddress,
  elcpAddress,
  stakedAmount,
  lockedStake,
}: {
  chainId: number
  aegisAddress: `0x${string}`
  elcpAddress: `0x${string}`
  stakedAmount: bigint
  lockedStake: bigint
}) {
  const activeChainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const [stakeInput, setStakeInput] = useState("")
  const [unstakeInput, setUnstakeInput] = useState("")
  const [stage, setStage] = useState<
    "idle" | "switching" | "approving" | "staking" | "unstaking" | "done"
  >("idle")
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)

  // ELCP is conventionally 18 decimals (Eclipse DAO governance token).
  const DECIMALS = 18
  const free = stakedAmount > lockedStake ? stakedAmount - lockedStake : 0n

  async function ensureChain() {
    if (activeChainId !== chainId) {
      setStage("switching")
      await switchChainAsync({ chainId: chainId as SupportedChainId })
    }
  }

  async function doStake() {
    setError(null)
    setHash(null)
    try {
      const amount = parseUnits(stakeInput || "0", DECIMALS)
      if (amount <= 0n) {
        setError("Enter an amount greater than 0.")
        return
      }
      await ensureChain()
      setStage("approving")
      const approveHash = await writeContractAsync({
        address: elcpAddress,
        abi: erc20Abi,
        functionName: "approve",
        args: [aegisAddress, amount],
        chainId: chainId as SupportedChainId,
      })
      setHash(approveHash)
      setStage("staking")
      const txHash = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: "stake",
        args: [amount],
        chainId: chainId as SupportedChainId,
      })
      setHash(txHash)
      setStage("done")
      setStakeInput("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "stake failed")
      setStage("idle")
    }
  }

  async function doUnstake() {
    setError(null)
    setHash(null)
    try {
      const amount = parseUnits(unstakeInput || "0", DECIMALS)
      if (amount <= 0n) {
        setError("Enter an amount greater than 0.")
        return
      }
      if (amount > free) {
        setError(
          `Only ${formatUnits(free, DECIMALS)} ELCP is free to withdraw; the rest is locked to active cases.`,
        )
        return
      }
      await ensureChain()
      setStage("unstaking")
      const txHash = await writeContractAsync({
        address: aegisAddress,
        abi: aegisAbi,
        functionName: "unstake",
        args: [amount],
        chainId: chainId as SupportedChainId,
      })
      setHash(txHash)
      setStage("done")
      setUnstakeInput("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "unstake failed")
      setStage("idle")
    }
  }

  const busy =
    stage === "switching" ||
    stage === "approving" ||
    stage === "staking" ||
    stage === "unstaking"

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-zinc-500">Staked</dt>
          <dd className="font-mono">{formatUnits(stakedAmount, DECIMALS)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Locked</dt>
          <dd className="font-mono">{formatUnits(lockedStake, DECIMALS)}</dd>
        </div>
        <div>
          <dt className="text-zinc-500">Free</dt>
          <dd className="font-mono">{formatUnits(free, DECIMALS)}</dd>
        </div>
      </dl>
      <p className="text-xs text-zinc-500">
        Locked stake is bonded to active cases and can&apos;t be withdrawn
        until those resolve.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input flex-1 min-w-32"
          placeholder="ELCP to stake"
          value={stakeInput}
          onChange={(e) => setStakeInput(e.target.value)}
          disabled={busy}
          inputMode="decimal"
        />
        <button
          className="btn-primary text-xs"
          onClick={doStake}
          disabled={busy || !stakeInput}
        >
          {stage === "approving"
            ? "Approving…"
            : stage === "staking"
              ? "Staking…"
              : "Stake"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input flex-1 min-w-32"
          placeholder="ELCP to unstake"
          value={unstakeInput}
          onChange={(e) => setUnstakeInput(e.target.value)}
          disabled={busy}
          inputMode="decimal"
        />
        <button
          className="btn-secondary text-xs"
          onClick={doUnstake}
          disabled={busy || !unstakeInput || free === 0n}
        >
          {stage === "unstaking" ? "Unstaking…" : "Unstake"}
        </button>
      </div>

      {stage === "switching" && (
        <div className="text-xs text-zinc-500">Switching wallet to chain {chainId}…</div>
      )}
      {hash && (
        <div className="font-mono text-xs text-emerald-700 dark:text-emerald-400">
          tx: {hash.slice(0, 10)}…
        </div>
      )}
      {error && (
        <div className="text-xs text-rose-700 dark:text-rose-300">{error}</div>
      )}
    </div>
  )
}
