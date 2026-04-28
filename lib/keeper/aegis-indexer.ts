import "server-only"
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem"
import { base, baseSepolia, hardhat } from "viem/chains"
import { eq, and, sql } from "drizzle-orm"

import { db, schema } from "@/lib/db/client"
import { aegisAbi } from "@/lib/abi/aegis"
import {
  recordCaseOpened,
  recordCaseRequested,
  recordResolution,
} from "@/lib/cases/service"

const CURSOR_KEY = "aegis-all"

interface IndexerConfig {
  chainId: number
  rpcUrl: string
  aegisAddress: Address
}

function chainFor(chainId: number) {
  if (chainId === base.id) return base
  if (chainId === baseSepolia.id) return baseSepolia
  if (chainId === hardhat.id) return hardhat
  throw new Error(`Unsupported chainId for aegis indexer: ${chainId}`)
}

async function getCursor(chainId: number, contract: Address): Promise<bigint> {
  const row = await db.query.indexerState.findFirst({
    where: (s, { and, eq }) =>
      and(
        eq(s.chainId, chainId),
        eq(s.contractAddress, contract.toLowerCase()),
        eq(s.eventName, CURSOR_KEY),
      ),
  })
  return row?.lastBlock ?? 0n
}

async function setCursor(chainId: number, contract: Address, lastBlock: bigint) {
  const lower = contract.toLowerCase()
  const existing = await db.query.indexerState.findFirst({
    where: (s, { and, eq }) =>
      and(
        eq(s.chainId, chainId),
        eq(s.contractAddress, lower),
        eq(s.eventName, CURSOR_KEY),
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
          eq(schema.indexerState.eventName, CURSOR_KEY),
        ),
      )
  } else {
    await db.insert(schema.indexerState).values({
      chainId,
      contractAddress: lower,
      eventName: CURSOR_KEY,
      lastBlock,
    })
  }
}

export interface AegisIndexerResult {
  scannedFromBlock: bigint
  scannedToBlock: bigint
  eventsApplied: number
}

/**
 * Scan Aegis logs since the last cursor and mirror state changes into the DB.
 * Idempotent — safe to run repeatedly.
 */
export async function indexAegisEvents(
  cfg: IndexerConfig,
): Promise<AegisIndexerResult> {
  const chain = chainFor(cfg.chainId)
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl) })

  const tip = await client.getBlockNumber()
  const cursor = await getCursor(cfg.chainId, cfg.aegisAddress)
  const fromBlock = cursor === 0n ? (tip > 5_000n ? tip - 5_000n : 0n) : cursor + 1n
  if (fromBlock > tip) {
    return { scannedFromBlock: fromBlock, scannedToBlock: tip, eventsApplied: 0 }
  }

  const logs = await client.getLogs({
    address: cfg.aegisAddress,
    fromBlock,
    toBlock: tip,
  })

  let applied = 0

  for (const rawLog of logs) {
    try {
      const decoded = decodeAegisLog(rawLog.topics, rawLog.data)
      if (!decoded) continue

      switch (decoded.eventName) {
        case "CaseRequested": {
          await applyCaseRequested(cfg, decoded.args)
          break
        }
        case "CaseOpened": {
          await applyCaseOpened(cfg, client, decoded.args, rawLog.transactionHash)
          break
        }
        case "Committed": {
          await applyCommitted(cfg, decoded.args, rawLog.transactionHash)
          break
        }
        case "Revealed": {
          await applyRevealed(cfg, decoded.args)
          break
        }
        case "CaseResolved": {
          await applyResolved(cfg, decoded.args, rawLog.transactionHash, "resolved")
          break
        }
        case "CaseDefaultResolved": {
          await applyResolved(cfg, decoded.args, rawLog.transactionHash, "default_resolved")
          break
        }
        case "PanelRedrawn": {
          await applyPanelRedrawn(cfg, decoded.args)
          break
        }
        case "Recused": {
          await applyRecused(cfg, decoded.args)
          break
        }
        case "ArbiterRegistered": {
          await applyArbiterRegistered(cfg, decoded.args)
          break
        }
        case "ArbiterRevoked": {
          await applyArbiterRevoked(cfg, decoded.args)
          break
        }
        case "StakeIncreased":
        case "StakeWithdrawn": {
          await applyStakeChange(cfg, decoded.args)
          break
        }
      }
      applied += 1
    } catch (err) {
      console.warn("[aegis-indexer] failed to apply log:", err)
    }
  }

  await setCursor(cfg.chainId, cfg.aegisAddress, tip)
  return {
    scannedFromBlock: fromBlock,
    scannedToBlock: tip,
    eventsApplied: applied,
  }
}

// ============================================================
// Decoding — restricted to the events we actually consume so the
// switch above is exhaustive and obvious.
// ============================================================

type DecodedLog =
  | { eventName: "CaseRequested"; args: any }
  | { eventName: "CaseOpened"; args: any }
  | { eventName: "Committed"; args: any }
  | { eventName: "Revealed"; args: any }
  | { eventName: "CaseResolved"; args: any }
  | { eventName: "CaseDefaultResolved"; args: any }
  | { eventName: "PanelStalled"; args: any }
  | { eventName: "PanelRedrawn"; args: any }
  | { eventName: "Recused"; args: any }
  | { eventName: "ArbiterRegistered"; args: any }
  | { eventName: "ArbiterRevoked"; args: any }
  | { eventName: "StakeIncreased"; args: any }
  | { eventName: "StakeWithdrawn"; args: any }

function decodeAegisLog(topics: readonly Hex[], data: Hex): DecodedLog | null {
  // Use viem's decodeEventLog with our autogenerated ABI for type-safety.
  // Imported lazily to avoid pulling decoder into bundle for callers that
  // only want the runner.
  const { decodeEventLog } = require("viem") as typeof import("viem")
  try {
    const decoded = decodeEventLog({
      abi: aegisAbi,
      topics: topics as any,
      data,
    })
    return { eventName: decoded.eventName as any, args: decoded.args }
  } catch {
    return null
  }
}

// ============================================================
// Handlers
// ============================================================

async function applyCaseRequested(cfg: IndexerConfig, args: any) {
  await recordCaseRequested({
    chainId: cfg.chainId,
    aegisAddress: cfg.aegisAddress,
    caseId: args.caseId,
    escrowAddress: args.escrow,
    escrowCaseId: args.escrowCaseId,
    partyA: args.partyA,
    partyB: args.partyB,
    feeToken: args.feeToken,
    amount: args.amount as bigint,
    panelSize: 0, // unknown at request time; CaseOpened will fill in panel size
  })
}

// `client` is intentionally typed loosely — viem's PublicClient is parameterized
// by chain attachment, and we don't want to leak that through this internal API.
async function applyCaseOpened(
  cfg: IndexerConfig,
  client: any,
  args: any,
  _txHash: Hex,
) {
  // The event encodes everything we need; no extra reads required.
  const panel = args.panel as Address[]
  // Pull deadlineCommit / deadlineReveal from chain — they're not in the event,
  // and we'd rather query than derive from policy + block.timestamp (which is
  // only the block this log is from, not necessarily 'now').
  const c = (await client.readContract({
    address: cfg.aegisAddress,
    abi: aegisAbi,
    functionName: "getCase",
    args: [args.caseId],
  })) as readonly any[]
  const deadlineCommit = new Date(Number(c[7]) * 1000)
  const deadlineReveal = new Date(Number(c[8]) * 1000)

  await recordCaseOpened({
    chainId: cfg.chainId,
    aegisAddress: cfg.aegisAddress,
    caseId: args.caseId,
    escrowAddress: args.escrow,
    escrowCaseId: args.escrowCaseId,
    partyA: args.partyA,
    partyB: args.partyB,
    feeToken: args.feeToken,
    amount: args.amount as bigint,
    panelSize: panel.length,
    deadlineCommit,
    deadlineReveal,
    panel: panel.map((address, seat) => ({ address, seat })),
  })
}

async function findCaseUuid(
  cfg: IndexerConfig,
  caseId: Hex,
): Promise<string | null> {
  const row = await db.query.cases.findFirst({
    where: (c, { eq, and }) =>
      and(
        eq(c.chainId, cfg.chainId),
        eq(c.aegisAddress, cfg.aegisAddress.toLowerCase()),
        eq(c.caseId, caseId.toLowerCase()),
      ),
    columns: { id: true },
  })
  return row?.id ?? null
}

async function applyCommitted(cfg: IndexerConfig, args: any, _txHash: Hex) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  await db
    .update(schema.panelMembers)
    .set({
      committedAt: new Date(),
      commitHash: args.commitHash,
    })
    .where(
      and(
        eq(schema.panelMembers.caseUuid, caseUuid),
        eq(
          schema.panelMembers.panelistAddress,
          (args.panelist as string).toLowerCase(),
        ),
      ),
    )
}

async function applyRevealed(cfg: IndexerConfig, args: any) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  await db
    .update(schema.panelMembers)
    .set({
      revealedAt: new Date(),
      partyAPercentage: Number(args.partyAPercentage),
      rationaleDigest: args.rationaleDigest,
    })
    .where(
      and(
        eq(schema.panelMembers.caseUuid, caseUuid),
        eq(
          schema.panelMembers.panelistAddress,
          (args.panelist as string).toLowerCase(),
        ),
      ),
    )
  // Bump the case status to 'revealing' if still 'open'.
  await db
    .update(schema.cases)
    .set({ status: "revealing", updatedAt: new Date() })
    .where(
      and(
        eq(schema.cases.id, caseUuid),
        eq(schema.cases.status, "open"),
      ),
    )
}

async function applyResolved(
  cfg: IndexerConfig,
  args: any,
  txHash: Hex,
  status: "resolved" | "default_resolved",
) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  // CaseResolved emits medianPercentage; CaseDefaultResolved emits fallbackPercentage.
  const pct = Number(args.medianPercentage ?? args.fallbackPercentage ?? 50)
  const finalDigest = (args.finalDigest as Hex | undefined) ?? null
  await recordResolution({
    caseUuid,
    status,
    medianPercentage: pct,
    finalDigest: (finalDigest ?? "0x") as Hex,
    resolutionTxHash: txHash,
  })
}

async function applyPanelRedrawn(cfg: IndexerConfig, args: any) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  const newPanel = (args.newPanel as Address[]).map((a, seat) => ({
    address: a.toLowerCase(),
    seat,
  }))
  // Mark current (still-active) panelists as 'redrawn' rather than deleting
  // them — this keeps a record on each arbiter's profile that they were on
  // a panel that stalled.
  await db
    .update(schema.panelMembers)
    .set({ leftAt: new Date(), leftReason: "redrawn" })
    .where(
      and(
        eq(schema.panelMembers.caseUuid, caseUuid),
        // only those still active (not previously recused)
        sql`${schema.panelMembers.leftAt} IS NULL`,
      ),
    )
  if (newPanel.length > 0) {
    await db.insert(schema.panelMembers).values(
      newPanel.map((p) => ({
        caseUuid,
        panelistAddress: p.address,
        seat: p.seat,
      })),
    )
  }
  await db
    .update(schema.cases)
    .set({ status: "open", round: 1, updatedAt: new Date() })
    .where(eq(schema.cases.id, caseUuid))
}

async function applyRecused(cfg: IndexerConfig, args: any) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  const seat = Number(args.seat)
  const replacement = (args.replacement as string).toLowerCase()
  const recused = (args.recused as string).toLowerCase()

  // Mark the recused panelist as left (rather than deleting) so the audit
  // trail survives. Insert the replacement as a new row at the same seat.
  await db
    .update(schema.panelMembers)
    .set({ leftAt: new Date(), leftReason: "recused" })
    .where(
      and(
        eq(schema.panelMembers.caseUuid, caseUuid),
        eq(schema.panelMembers.panelistAddress, recused),
      ),
    )
  await db.insert(schema.panelMembers).values({
    caseUuid,
    panelistAddress: replacement,
    seat,
  })
}

async function applyArbiterRegistered(cfg: IndexerConfig, args: any) {
  const addr = (args.arbiter as string).toLowerCase()
  const existing = await db.query.arbiters.findFirst({
    where: (a, { and, eq }) =>
      and(eq(a.chainId, cfg.chainId), eq(a.address, addr)),
  })
  if (existing) {
    await db
      .update(schema.arbiters)
      .set({
        status: "active",
        credentialCID: args.credentialCID,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.arbiters.chainId, cfg.chainId),
          eq(schema.arbiters.address, addr),
        ),
      )
  } else {
    await db.insert(schema.arbiters).values({
      chainId: cfg.chainId,
      address: addr,
      status: "active",
      credentialCID: args.credentialCID,
    })
  }
}

async function applyArbiterRevoked(cfg: IndexerConfig, args: any) {
  const addr = (args.arbiter as string).toLowerCase()
  await db
    .update(schema.arbiters)
    .set({ status: "revoked", stakedAmount: "0", updatedAt: new Date() })
    .where(
      and(
        eq(schema.arbiters.chainId, cfg.chainId),
        eq(schema.arbiters.address, addr),
      ),
    )
}

async function applyStakeChange(cfg: IndexerConfig, args: any) {
  const addr = (args.arbiter as string).toLowerCase()
  await db
    .update(schema.arbiters)
    .set({
      stakedAmount: (args.newTotal as bigint).toString(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.arbiters.chainId, cfg.chainId),
        eq(schema.arbiters.address, addr),
      ),
    )
}

// Suppressed — pulled in lazily inside decodeAegisLog. Re-exported here
// only so callers can build their own decoders if they need to.
export { parseAbiItem }
