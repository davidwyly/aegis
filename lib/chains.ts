import { base, baseSepolia, hardhat } from "wagmi/chains"
import type { Chain } from "wagmi/chains"

export interface ChainData {
  chain: Chain
  name: string
  shortName: string
  explorerUrl: string
  isTestnet: boolean
  aegis?: `0x${string}`
  vaultraAdapter?: `0x${string}`
  vaultra?: `0x${string}`
  eclipseGovernance?: `0x${string}`
  elcp?: `0x${string}`
}

const env = (k: string) =>
  ((process.env[k] ?? "") as `0x${string}` | "") || undefined

export const supportedChains = [base, baseSepolia, hardhat] as const
export type SupportedChainId = (typeof supportedChains)[number]["id"]

const chainData: Record<number, ChainData> = {
  [base.id]: {
    chain: base,
    name: "Base",
    shortName: "Base",
    explorerUrl: "https://basescan.org",
    isTestnet: false,
    aegis: env("NEXT_PUBLIC_AEGIS_BASE"),
    vaultraAdapter: env("NEXT_PUBLIC_VAULTRA_ADAPTER_BASE"),
    vaultra: env("NEXT_PUBLIC_VAULTRA_BASE"),
    eclipseGovernance: env("NEXT_PUBLIC_ECLIPSE_GOVERNANCE_BASE"),
    elcp: env("NEXT_PUBLIC_ELCP_BASE"),
  },
  [baseSepolia.id]: {
    chain: baseSepolia,
    name: "Base Sepolia",
    shortName: "Base Sepolia",
    explorerUrl: "https://sepolia.basescan.org",
    isTestnet: true,
    aegis: env("NEXT_PUBLIC_AEGIS_BASE_SEPOLIA"),
    vaultraAdapter: env("NEXT_PUBLIC_VAULTRA_ADAPTER_BASE_SEPOLIA"),
    vaultra: env("NEXT_PUBLIC_VAULTRA_BASE_SEPOLIA"),
    eclipseGovernance: env("NEXT_PUBLIC_ECLIPSE_GOVERNANCE_BASE_SEPOLIA"),
    elcp: env("NEXT_PUBLIC_ELCP_BASE_SEPOLIA"),
  },
  [hardhat.id]: {
    chain: hardhat,
    name: "Hardhat (Local)",
    shortName: "Hardhat",
    explorerUrl: "http://127.0.0.1:8545",
    isTestnet: true,
    aegis: env("NEXT_PUBLIC_AEGIS_HARDHAT"),
    vaultraAdapter: env("NEXT_PUBLIC_VAULTRA_ADAPTER_HARDHAT"),
    vaultra: env("NEXT_PUBLIC_VAULTRA_HARDHAT"),
    elcp: env("NEXT_PUBLIC_ELCP_HARDHAT"),
  },
}

export function getChainData(chainId?: number): ChainData {
  if (!chainId) return chainData[base.id]
  return chainData[chainId] ?? chainData[base.id]
}

export function requireAegis(chainId: number): `0x${string}` {
  const a = chainData[chainId]?.aegis
  if (!a)
    throw new Error(
      `Aegis not configured for chainId ${chainId}. Set NEXT_PUBLIC_AEGIS_*.`,
    )
  return a
}

export function requireVaultra(chainId: number): `0x${string}` {
  const a = chainData[chainId]?.vaultra
  if (!a) throw new Error(`Vaultra not configured for chainId ${chainId}.`)
  return a
}

export function getExplorerAddressUrl(chainId: number, address: string) {
  return `${getChainData(chainId).explorerUrl}/address/${address}`
}

export function getExplorerTxUrl(chainId: number, hash: string) {
  return `${getChainData(chainId).explorerUrl}/tx/${hash}`
}

export function chainsWithAegis(): ChainData[] {
  return supportedChains.map((c) => chainData[c.id]).filter((d) => Boolean(d.aegis))
}

/**
 * Public RPC URL for a chain. Hardhat falls back to the local default so
 * `pnpm dev` works without explicit env wiring. Returns undefined for
 * unsupported chains so callers can decide how to fail (viem's http()
 * tolerates undefined → uses the chain's default RPC).
 */
export function rpcUrlFor(chainId: number): string | undefined {
  if (chainId === base.id) return process.env.NEXT_PUBLIC_BASE_RPC_URL
  if (chainId === baseSepolia.id) return process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL
  if (chainId === hardhat.id) {
    return process.env.NEXT_PUBLIC_HARDHAT_RPC_URL ?? "http://127.0.0.1:8545"
  }
  return undefined
}

/**
 * viem `Chain` for a chainId. Throws on unsupported chains — keeper /
 * indexer paths need a hard failure rather than silently mis-configuring
 * a client. Pages that want a soft path should use getChainData().chain.
 */
export function viemChainFor(chainId: number): Chain {
  const data = chainData[chainId]
  if (!data) throw new Error(`Unsupported chainId: ${chainId}`)
  return data.chain
}
