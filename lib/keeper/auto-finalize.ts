import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { base, baseSepolia, hardhat } from "viem/chains"
import { lt, eq, and, inArray, type SQL } from "drizzle-orm"

import { db, schema } from "@/lib/db/client"
import { aegisAbi } from "@/lib/abi/aegis"

interface AutoFinalizeConfig {
  chainId: number
  rpcUrl: string
  aegisAddress: Address
  privateKey: Hex
}

function chainFor(chainId: number) {
  if (chainId === base.id) return base
  if (chainId === baseSepolia.id) return baseSepolia
  if (chainId === hardhat.id) return hardhat
  throw new Error(`Unsupported chainId: ${chainId}`)
}

export interface AutoFinalizeResult {
  scanned: number
  finalized: number
  errors: Array<{ caseId: string; reason: string }>
}

/**
 * Find cases whose reveal window (+ grace) has expired but whose DB row
 * still says they're in-flight, and call `Aegis.finalize` on each. Idempotent:
 * if another caller has already finalized a case on chain, the indexer will
 * sweep up the resolved state on its next pass.
 *
 * Designed to be called once per keeper tick.
 */
export async function autoFinalizePending(
  cfg: AutoFinalizeConfig,
): Promise<AutoFinalizeResult> {
  const now = new Date()
  const chain = chainFor(cfg.chainId)
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
  const account = privateKeyToAccount(cfg.privateKey)
  const walletClient = createWalletClient({
    chain,
    transport: http(cfg.rpcUrl),
    account,
  })

  // Two finalize-eligibility patterns covered here:
  //   (a) Original phase: status in {open, revealing}, deadlineReveal
  //       has elapsed. finalize() either applies the verdict (no-appeal
  //       happy path is direct) or triggers stall fallback.
  //   (b) Appeal phase: status in {appeal_open, appeal_revealing}, the
  //       appeal reveal deadline (also stored in deadlineReveal, since
  //       the indexer overwrites it on the phase transition) has
  //       elapsed — finalize() computes the median + applies it.
  //
  // Not covered here: AppealableResolved → Resolved transition when the
  // appeal window expires. The schema doesn't track appealDeadline as a
  // column yet; finalize for that path is left to manual triggering or
  // to a follow-up that adds the column + indexer wiring.
  const inflight: SQL = and(
    eq(schema.cases.chainId, cfg.chainId),
    eq(schema.cases.aegisAddress, cfg.aegisAddress.toLowerCase()),
    inArray(schema.cases.status, [
      "open",
      "revealing",
      "appeal_open",
      "appeal_revealing",
    ]),
    lt(schema.cases.deadlineReveal, now),
  ) as SQL

  const candidates = await db.query.cases.findMany({
    where: inflight,
    limit: 50,
  })

  const errors: Array<{ caseId: string; reason: string }> = []
  let finalized = 0

  for (const c of candidates) {
    try {
      const { request } = await publicClient.simulateContract({
        account,
        address: cfg.aegisAddress,
        abi: aegisAbi,
        functionName: "finalize",
        args: [c.caseId as Hex],
      })
      const hash = await walletClient.writeContract(request)
      await publicClient.waitForTransactionReceipt({ hash })
      finalized += 1
    } catch (err) {
      // Common reasons:
      //   - GraceWindowOpen: not yet past the slash grace; tick again later
      //   - CaseAlreadyFinalized: another caller / earlier tick won
      //   - RevealWindowOpen: clock skew between DB and chain
      // Logging without re-throwing because one bad case shouldn't
      // block the rest of the queue.
      errors.push({
        caseId: c.caseId,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { scanned: candidates.length, finalized, errors }
}
