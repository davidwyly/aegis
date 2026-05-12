import "server-only"
import { createPublicClient, erc20Abi, http } from "viem"
import { rpcUrlFor, supportedChains } from "@/lib/chains"
import { aegisAbi } from "@/lib/abi/aegis"

function publicClientFor(chainId: number) {
  const chain = supportedChains.find((c) => c.id === chainId)
  if (!chain) return null
  return createPublicClient({ chain, transport: http(rpcUrlFor(chainId)) })
}

export async function readLockedStake(
  chainId: number,
  aegisAddress: `0x${string}`,
  arbiter: `0x${string}`,
): Promise<bigint> {
  const client = publicClientFor(chainId)
  if (!client) return 0n
  try {
    return (await client.readContract({
      address: aegisAddress,
      abi: aegisAbi,
      functionName: "lockedStake",
      args: [arbiter],
    })) as bigint
  } catch {
    return 0n
  }
}

export async function readClaimable(
  chainId: number,
  aegisAddress: `0x${string}`,
  arbiter: `0x${string}`,
  token: `0x${string}`,
): Promise<bigint> {
  const client = publicClientFor(chainId)
  if (!client) return 0n
  try {
    return (await client.readContract({
      address: aegisAddress,
      abi: aegisAbi,
      functionName: "claimable",
      args: [arbiter, token],
    })) as bigint
  } catch {
    return 0n
  }
}

export async function readTokenMetadata(
  chainId: number,
  token: `0x${string}`,
): Promise<{ symbol: string; decimals: number } | null> {
  const client = publicClientFor(chainId)
  if (!client) return null
  try {
    const symbol = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "symbol",
    })
    const decimals = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })
    if (typeof symbol !== "string" || typeof decimals !== "number") {
      return null
    }
    return { symbol, decimals }
  } catch {
    return null
  }
}
