import "server-only"
import { createPublicClient, http } from "viem"
import { supportedChains } from "@/lib/chains"
import { aegisAbi } from "@/lib/abi/aegis"

const DEFAULT_APPEAL_FEE_BPS = 250

const RPC_URL_ENV: Record<number, string | undefined> = {
  8453: process.env.NEXT_PUBLIC_BASE_RPC_URL,
  84532: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
  31337: process.env.NEXT_PUBLIC_HARDHAT_RPC_URL ?? "http://127.0.0.1:8545",
}

export async function readAppealFeeBps(
  chainId: number,
  aegisAddress: `0x${string}`,
): Promise<number> {
  const chain = supportedChains.find((c) => c.id === chainId)
  if (!chain) return DEFAULT_APPEAL_FEE_BPS
  try {
    const client = createPublicClient({
      chain,
      transport: http(RPC_URL_ENV[chainId]),
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
