import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { eq, and } from "drizzle-orm"
import { base, baseSepolia, hardhat } from "viem/chains"

import { db, schema } from "@/lib/db/client"
import { aegisAbi } from "@/lib/abi/aegis"
import { vaultraAdapterAbi } from "@/lib/abi/vaultra-adapter"
import { vaultraDisputeEventsAbi } from "@/lib/abi/vaultra-events"
import { recordCaseOpened } from "@/lib/cases/service"

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const
import { indexAegisEvents, type AegisIndexerResult } from "./aegis-indexer"
import { autoFinalizePending, type AutoFinalizeResult } from "./auto-finalize"
import { recordFailure, markResolved } from "./failures"

/**
 * Keeper: bridges Vaultra → Aegis.
 *
 * Each tick:
 *   1. Read indexer cursor for (chainId, vaultra address, "DisputeRaised")
 *   2. Fetch new DisputeRaised + DisputeRaisedNoMilestone logs
 *   3. For each, call adapter.registerCase + aegis.openDispute (if not already)
 *   4. Index the resulting CaseOpened event into the DB
 *   5. Advance cursor
 *
 * Designed to be idempotent — re-running it is safe.
 */

interface KeeperConfig {
  chainId: number
  rpcUrl: string
  aegisAddress: Address
  adapterAddress: Address
  vaultraAddress: Address
  privateKey: Hex
}

function chainFor(chainId: number) {
  if (chainId === base.id) return base
  if (chainId === baseSepolia.id) return baseSepolia
  if (chainId === hardhat.id) return hardhat
  throw new Error(`Unsupported chainId for keeper: ${chainId}`)
}

async function getCursor(
  chainId: number,
  contract: Address,
  eventName: string,
): Promise<bigint> {
  const row = await db.query.indexerState.findFirst({
    where: (s, { and, eq }) =>
      and(
        eq(s.chainId, chainId),
        eq(s.contractAddress, contract.toLowerCase()),
        eq(s.eventName, eventName),
      ),
  })
  return row?.lastBlock ?? 0n
}

async function setCursor(
  chainId: number,
  contract: Address,
  eventName: string,
  lastBlock: bigint,
) {
  const lower = contract.toLowerCase()
  const existing = await db.query.indexerState.findFirst({
    where: (s, { and, eq }) =>
      and(
        eq(s.chainId, chainId),
        eq(s.contractAddress, lower),
        eq(s.eventName, eventName),
      ),
  })
  if (existing) {
    await db
      .update(schema.indexerState)
      .set({ lastBlock, updatedAt: new Date() })
      .where(
        and(
          eq(schema.indexerState.chainId, chainId),
          eq(schema.indexerState.contractAddress, lower),
          eq(schema.indexerState.eventName, eventName),
        ),
      )
  } else {
    await db.insert(schema.indexerState).values({
      chainId,
      contractAddress: lower,
      eventName,
      lastBlock,
    })
  }
}

export interface KeeperTickResult {
  scannedFromBlock: bigint
  scannedToBlock: bigint
  raisesSeen: number
  casesOpened: number
  aegisIndexer: AegisIndexerResult
  autoFinalize: AutoFinalizeResult
}

/**
 * Run one keeper pass. Returns a summary so callers (CLI, cron, web admin)
 * can log progress.
 */
export async function keeperTick(cfg: KeeperConfig): Promise<KeeperTickResult> {
  const chain = chainFor(cfg.chainId)
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) })
  const account = privateKeyToAccount(cfg.privateKey)
  const walletClient = createWalletClient({
    chain,
    transport: http(cfg.rpcUrl),
    account,
  })

  const tip = await publicClient.getBlockNumber()
  const cursor = await getCursor(cfg.chainId, cfg.vaultraAddress, "DisputeRaised")
  const fromBlock = cursor === 0n ? tip - 5_000n > 0n ? tip - 5_000n : 0n : cursor + 1n
  // If the bridge has nothing to scan (Vaultra cursor caught up), still run
  // the Aegis indexer below so commits/reveals/resolutions still flow.
  const bridgeIdle = fromBlock > tip

  const milestoneLogs = bridgeIdle
    ? []
    : await publicClient.getLogs({
        address: cfg.vaultraAddress,
        event: vaultraDisputeEventsAbi[0],
        fromBlock,
        toBlock: tip,
      })
  const noMilestoneLogs = bridgeIdle
    ? []
    : await publicClient.getLogs({
        address: cfg.vaultraAddress,
        event: vaultraDisputeEventsAbi[1],
        fromBlock,
        toBlock: tip,
      })

  let casesOpened = 0
  const raises = [
    ...milestoneLogs.map((l) => ({
      escrowId: l.args.escrowId as Hex,
      milestoneIndex: BigInt(l.args.milestoneIndex ?? 0n),
      noMilestone: false,
    })),
    ...noMilestoneLogs.map((l) => ({
      escrowId: l.args.escrowId as Hex,
      milestoneIndex: 0n,
      noMilestone: true,
    })),
  ]

  for (const r of raises) {
    try {
      // Step 1: register the case on the adapter (skips if already registered).
      const expectedCaseId = (await publicClient.readContract({
        address: cfg.adapterAddress,
        abi: vaultraAdapterAbi,
        functionName: "packCaseId",
        args: [r.escrowId, r.milestoneIndex, r.noMilestone],
      })) as Hex
      const existing = (await publicClient.readContract({
        address: cfg.adapterAddress,
        abi: vaultraAdapterAbi,
        functionName: "caseInfo",
        args: [expectedCaseId],
      })) as readonly [Hex, bigint, boolean, boolean]
      const alreadyRegistered = existing[3]

      if (!alreadyRegistered) {
        const { request: regReq } = await publicClient.simulateContract({
          account,
          address: cfg.adapterAddress,
          abi: vaultraAdapterAbi,
          functionName: "registerCase",
          args: [r.escrowId, r.milestoneIndex, r.noMilestone],
        })
        const regHash = await walletClient.writeContract(regReq)
        await publicClient.waitForTransactionReceipt({ hash: regHash })
      }

      // Skip openDispute if Aegis already has a live case for this
      // (adapter, packed-caseId) pair — another keeper / a previous run
      // already opened it. The Aegis indexer will sweep up the
      // CaseOpened event so the DB row exists either way.
      const live = (await publicClient.readContract({
        address: cfg.aegisAddress,
        abi: aegisAbi,
        functionName: "liveCaseFor",
        args: [cfg.adapterAddress, expectedCaseId],
      })) as Hex
      if (
        live !==
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        continue
      }

      // Step 2: open the dispute on Aegis.
      const { request: openReq, result: aegisCaseId } =
        await publicClient.simulateContract({
          account,
          address: cfg.aegisAddress,
          abi: aegisAbi,
          functionName: "openDispute",
          args: [cfg.adapterAddress, expectedCaseId],
        })
      const openHash = await walletClient.writeContract(openReq)
      const receipt = await publicClient.waitForTransactionReceipt({ hash: openHash })

      // Step 3: read the case back from chain to fill the DB row. Under
      // the new design getCase returns a CaseView struct (not a tuple)
      // and there is no panel — a single original arbiter is drawn by
      // the VRF callback and emitted via ArbiterDrawn separately.
      const c = (await publicClient.readContract({
        address: cfg.aegisAddress,
        abi: aegisAbi,
        functionName: "getCase",
        args: [aegisCaseId as Hex],
      })) as {
        escrow: Address
        escrowCaseId: Hex
        partyA: Address
        partyB: Address
        feeToken: Address
        amount: bigint
        state: number
        stallRound: number
        openedAt: bigint
        originalArbiter: Address
        originalCommitHash: Hex
        originalPercentage: number
        originalDigest: Hex
        originalCommitDeadline: bigint
        originalRevealDeadline: bigint
        originalRevealed: boolean
        appellant: Address
        appealDeadline: bigint
        appealCommitDeadline: bigint
        appealRevealDeadline: bigint
        appealFeeAmount: bigint
        escrowFeeReceived: bigint
        feesDistributed: boolean
      }
      void receipt

      // The original arbiter is populated by the VRF callback. If the
      // callback hasn't fulfilled yet, originalArbiter is the zero
      // address — recordCaseOpened tolerates an empty panel and the
      // ArbiterDrawn event handler fills the panel later.
      const arbiterPanel: { address: Address; seat: number }[] =
        c.originalArbiter !== ZERO_ADDRESS
          ? [{ address: c.originalArbiter, seat: 0 }]
          : []

      await recordCaseOpened({
        chainId: cfg.chainId,
        aegisAddress: cfg.aegisAddress,
        caseId: aegisCaseId as Hex,
        escrowAddress: cfg.adapterAddress, // adapter is the IArbitrableEscrow Aegis sees
        escrowCaseId: expectedCaseId,
        partyA: c.partyA,
        partyB: c.partyB,
        feeToken: c.feeToken,
        amount: c.amount,
        panelSize: arbiterPanel.length,
        deadlineCommit: new Date(Number(c.originalCommitDeadline) * 1000),
        deadlineReveal: new Date(Number(c.originalRevealDeadline) * 1000),
        panel: arbiterPanel,
      })
      casesOpened += 1

      // Clear any prior failure log for this dispute — we just opened it.
      await markResolved({
        chainId: cfg.chainId,
        vaultraAddress: cfg.vaultraAddress,
        escrowId: r.escrowId,
        milestoneIndex: r.milestoneIndex,
        noMilestone: r.noMilestone,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.warn(
        `[keeper] failed to open case for escrow ${r.escrowId} milestone ${r.milestoneIndex}:`,
        reason,
      )
      // Track the failure so /admin can surface stuck imports without a log
      // grep. Keeper retries on every tick; `attempts` and `lastAttempted`
      // make it obvious which disputes are permanently stuck vs. transient.
      try {
        await recordFailure(
          {
            chainId: cfg.chainId,
            vaultraAddress: cfg.vaultraAddress,
            escrowId: r.escrowId,
            milestoneIndex: r.milestoneIndex,
            noMilestone: r.noMilestone,
          },
          reason,
        )
      } catch (logErr) {
        console.warn("[keeper] also failed to record failure:", logErr)
      }
    }
  }

  if (!bridgeIdle) {
    await setCursor(cfg.chainId, cfg.vaultraAddress, "DisputeRaised", tip)
  }

  // Mirror Aegis's own events into the DB so the UI reflects on-chain state
  // (commits, reveals, resolutions, slashing, panel redraws, roster changes).
  // Runs after the bridge so any cases we just opened are present in the DB
  // before their CaseOpened event might be processed.
  const aegisIndexer = await indexAegisEvents({
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl,
    aegisAddress: cfg.aegisAddress,
  })

  // Sweep stalled cases — those whose reveal+grace windows have closed but
  // are still 'open' / 'revealing' in the DB. The keeper acts as the
  // anyone-can-poke caller of finalize so operators don't have to babysit.
  const autoFinalize = await autoFinalizePending({
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl,
    aegisAddress: cfg.aegisAddress,
    privateKey: cfg.privateKey,
  })

  return {
    scannedFromBlock: fromBlock,
    scannedToBlock: tip,
    raisesSeen: raises.length,
    casesOpened,
    aegisIndexer,
    autoFinalize,
  }
}

// re-export parseAbi for callers if they want to extend
export { parseAbi }
