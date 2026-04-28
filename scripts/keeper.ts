#!/usr/bin/env tsx
/**
 * One-shot keeper tick. Run on a cron / loop / systemd timer.
 *
 * Required env:
 *   KEEPER_PRIVATE_KEY            — server-side signing key for openDispute
 *   KEEPER_CHAIN_ID               — 8453 | 84532 | 31337
 *   KEEPER_RPC_URL                — JSON-RPC endpoint
 *   NEXT_PUBLIC_AEGIS_<CHAIN>     — deployed Aegis address
 *   NEXT_PUBLIC_VAULTRA_ADAPTER_<CHAIN>
 *   NEXT_PUBLIC_VAULTRA_<CHAIN>
 *   DATABASE_URL
 */
import "dotenv/config"
import { keeperTick } from "@/lib/keeper/service"
import { base, baseSepolia, hardhat } from "viem/chains"
import type { Address, Hex } from "viem"

function envOrThrow(k: string): string {
  const v = process.env[k]
  if (!v) throw new Error(`Missing env: ${k}`)
  return v
}

function chainSuffix(chainId: number): string {
  if (chainId === base.id) return "BASE"
  if (chainId === baseSepolia.id) return "BASE_SEPOLIA"
  if (chainId === hardhat.id) return "HARDHAT"
  throw new Error(`Unsupported keeper chainId ${chainId}`)
}

async function main() {
  const chainId = Number(envOrThrow("KEEPER_CHAIN_ID"))
  const suffix = chainSuffix(chainId)

  const result = await keeperTick({
    chainId,
    rpcUrl: envOrThrow("KEEPER_RPC_URL"),
    aegisAddress: envOrThrow(`NEXT_PUBLIC_AEGIS_${suffix}`) as Address,
    adapterAddress: envOrThrow(`NEXT_PUBLIC_VAULTRA_ADAPTER_${suffix}`) as Address,
    vaultraAddress: envOrThrow(`NEXT_PUBLIC_VAULTRA_${suffix}`) as Address,
    privateKey: envOrThrow("KEEPER_PRIVATE_KEY") as Hex,
  })

  console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
