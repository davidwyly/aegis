import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem"
import { hardhat } from "viem/chains"
import { privateKeyToAccount } from "viem/accounts"

import { aegisAbi } from "@/lib/abi/aegis"

/**
 * Drives Aegis state transitions from the test process. UI-side wagmi
 * interactions could be wired up later via an injected window.ethereum
 * EIP-1193 mock; for the v1 happy-path harness we issue the same calls
 * directly and rely on the UI to reflect the resulting state on reload.
 */

interface Ctx {
  rpcUrl: string
  aegis: Address
  privateKey: Hex
}

function clients(ctx: Ctx) {
  const account = privateKeyToAccount(ctx.privateKey)
  const publicClient = createPublicClient({ chain: hardhat, transport: http(ctx.rpcUrl) })
  const walletClient = createWalletClient({ account, chain: hardhat, transport: http(ctx.rpcUrl) })
  return { account, publicClient, walletClient }
}

/** Compute the keccak commit hash exactly the way Aegis hashes a vote. */
export function computeCommitHash(
  arbiter: Address,
  caseId: Hex,
  partyAPercentage: number,
  salt: Hex,
  rationaleDigest: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "uint16" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [arbiter, caseId, partyAPercentage, salt, rationaleDigest],
    ),
  )
}

export interface CommitResult {
  commitHash: Hex
  salt: Hex
  rationaleDigest: Hex
  partyAPercentage: number
}

export async function commitVote(
  ctx: Ctx,
  caseId: Hex,
  partyAPercentage: number,
  rationale: string,
): Promise<CommitResult> {
  const { account, publicClient, walletClient } = clients(ctx)
  const salt = ("0x" + "ab".repeat(32)) as Hex
  const rationaleDigest = keccak256(toHex(rationale))
  const commitHash = computeCommitHash(account.address, caseId, partyAPercentage, salt, rationaleDigest)

  const hash = await walletClient.writeContract({
    address: ctx.aegis,
    abi: aegisAbi,
    functionName: "commitVote",
    args: [caseId, commitHash],
  })
  await publicClient.waitForTransactionReceipt({ hash })

  return { commitHash, salt, rationaleDigest, partyAPercentage }
}

export async function revealVote(
  ctx: Ctx,
  caseId: Hex,
  reveal: CommitResult,
): Promise<void> {
  const { publicClient, walletClient } = clients(ctx)
  const hash = await walletClient.writeContract({
    address: ctx.aegis,
    abi: aegisAbi,
    functionName: "revealVote",
    args: [caseId, reveal.partyAPercentage, reveal.salt, reveal.rationaleDigest],
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

/**
 * Skip the commit window on the local hardhat node so the contract accepts
 * the reveal. Uses the standard `evm_increaseTime` + `evm_mine` JSON-RPC
 * helpers exposed by hardhat.
 */
export async function advanceTime(rpcUrl: string, seconds: number): Promise<void> {
  const body = (method: string, params: unknown[]) =>
    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body("evm_increaseTime", [seconds]),
  })
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body("evm_mine", []),
  })
}
