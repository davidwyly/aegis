import "server-only"
import { createPublicClient, http } from "viem"
import { rpcUrlFor, supportedChains } from "@/lib/chains"
import { aegisAbi } from "@/lib/abi/aegis"

export const DEFAULT_APPEAL_FEE_BPS = 250

export async function readAppealFeeBps(
  chainId: number,
  aegisAddress: `0x${string}`,
): Promise<number> {
  const chain = supportedChains.find((c) => c.id === chainId)
  if (!chain) return DEFAULT_APPEAL_FEE_BPS
  try {
    const client = createPublicClient({
      chain,
      transport: http(rpcUrlFor(chainId)),
    })
    const policy = (await client.readContract({
      address: aegisAddress,
      abi: aegisAbi,
      functionName: "policy",
    })) as readonly unknown[]
    // policy() returns the Policy struct as a tuple — appealFeeBps is at
    // index 6 (commitWindow, revealWindow, graceWindow, appealWindow,
    // repeatArbiterCooldown, stakeRequirement, appealFeeBps, ...).
    const bps = policy[6]
    if (typeof bps === "number") return bps
    if (typeof bps === "bigint") return Number(bps)
    return DEFAULT_APPEAL_FEE_BPS
  } catch {
    return DEFAULT_APPEAL_FEE_BPS
  }
}
