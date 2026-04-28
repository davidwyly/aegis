#!/usr/bin/env node
/**
 * Pulls ABIs out of hardhat artifacts into lib/abi/*.ts so the Next.js app
 * has fresh contract interfaces after every contract change.
 *
 * Usage: pnpm contracts:export-abi
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")

const targets = [
  {
    artifact: "blockchain/artifacts/contracts/Aegis.sol/Aegis.json",
    out: "lib/abi/aegis.ts",
    name: "aegisAbi",
  },
  {
    artifact:
      "blockchain/artifacts/contracts/adapters/VaultraAdapter.sol/VaultraAdapter.json",
    out: "lib/abi/vaultra-adapter.ts",
    name: "vaultraAdapterAbi",
  },
  {
    artifact:
      "blockchain/artifacts/contracts/interfaces/IArbitrableEscrow.sol/IArbitrableEscrow.json",
    out: "lib/abi/arbitrable-escrow.ts",
    name: "arbitrableEscrowAbi",
  },
]

for (const t of targets) {
  const path = resolve(root, t.artifact)
  if (!existsSync(path)) {
    console.warn(`[export-abi] missing artifact: ${path} — run 'pnpm contracts:compile' first`)
    continue
  }
  const json = JSON.parse(readFileSync(path, "utf8"))
  const outPath = resolve(root, t.out)
  mkdirSync(dirname(outPath), { recursive: true })
  const body = `// AUTO-GENERATED from ${t.artifact}. Do not hand-edit.\n` +
    `export const ${t.name} = ${JSON.stringify(json.abi, null, 2)} as const\n`
  writeFileSync(outPath, body)
  console.log(`[export-abi] wrote ${t.out}`)
}
