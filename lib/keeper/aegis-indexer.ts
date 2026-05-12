import {
  createPublicClient,
  decodeEventLog,
  http,
  parseAbiItem,
  zeroAddress,
  type Address,
  type DecodeEventLogReturnType,
  type Hex,
  type PublicClient,
} from "viem"
import { eq, and, sql } from "drizzle-orm"

import { db, schema } from "@/lib/db/client"
import { viemChainFor } from "@/lib/chains"
import { aegisAbi } from "@/lib/abi/aegis"
import {
  recordCaseOpened,
  recordCaseRequested,
  recordResolution,
} from "@/lib/cases/service"

// Discriminated union over every aegis event, with args typed straight
// from the ABI. Using viem's inferred return type means a rename in
// the Solidity event (and corresponding ABI regen) surfaces as a TS
// error at the handler call site instead of a silent no-op at runtime.
type AegisDecoded = DecodeEventLogReturnType<typeof aegisAbi>
type ArgsFor<E extends AegisDecoded["eventName"]> = Extract<
  AegisDecoded,
  { eventName: E }
>["args"]

const CURSOR_KEY = "aegis-all"

interface IndexerConfig {
  chainId: number
  rpcUrl: string
  aegisAddress: Address
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
  const chain = viemChainFor(cfg.chainId)
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
      const decoded = decodeAegisLog(rawLog)
      if (!decoded) continue

      // Only count toward `eventsApplied` when a handler actually
      // ran. decodeAegisLog can return any event in aegisAbi; the
      // switch covers a subset, and intentionally-no-op cases
      // (Stalled, PartyRebated) shouldn't inflate the counter either.
      let handled = true
      switch (decoded.eventName) {
        case "CaseRequested": {
          await applyCaseRequested(cfg, decoded.args)
          break
        }
        case "CaseOpened": {
          await applyCaseOpened(cfg, client, decoded.args, rawLog.transactionHash)
          break
        }
        case "ArbiterDrawn": {
          // Phase-agnostic arbiter assignment (de novo). Routes to
          // the right slot based on current case state.
          await applyArbiterDrawn(cfg, decoded.args)
          break
        }
        case "ArbiterRedrawn": {
          await applyArbiterRedrawn(cfg, decoded.args)
          break
        }
        case "Committed": {
          await applyCommitted(cfg, decoded.args, rawLog.transactionHash)
          break
        }
        case "Revealed": {
          await applyRevealed(cfg, client, decoded.args)
          break
        }
        case "CaseResolved": {
          await applyCaseResolved(cfg, decoded.args, rawLog.transactionHash)
          break
        }
        case "CaseDefaultResolved": {
          await applyCaseDefaultResolved(cfg, decoded.args, rawLog.transactionHash)
          break
        }
        case "Recused": {
          await applyRecused(cfg, decoded.args)
          break
        }
        case "AppealRequested": {
          await applyStatusUpdate(cfg, decoded.args.caseId, "appeal_awaiting_panel")
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
        default:
          // Stalled (sweeps via same-tx CaseResolved/DefaultResolved),
          // PartyRebated (the claim() event reflects movement), and
          // anything else in the ABI we don't index yet. Decoded
          // successfully but not applied.
          handled = false
      }
      if (handled) applied += 1
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
// Decoding — viem.decodeEventLog returns AegisDecoded for our ABI,
// so the eventName + args pair is a discriminated union TS can narrow.
// ============================================================

function decodeAegisLog(log: {
  topics: readonly Hex[]
  data: Hex
}): AegisDecoded | null {
  try {
    return decodeEventLog({
      abi: aegisAbi,
      // viem types topics as a sized tuple per ABI inputs; raw log
      // topics are a runtime-length array. The cast bridges that with
      // no runtime effect.
      topics: log.topics as [Hex, ...Hex[]],
      data: log.data,
    })
  } catch {
    return null
  }
}

// ============================================================
// Handlers
// ============================================================

async function applyCaseRequested(
  cfg: IndexerConfig,
  args: ArgsFor<"CaseRequested">,
) {
  await recordCaseRequested({
    chainId: cfg.chainId,
    aegisAddress: cfg.aegisAddress,
    caseId: args.caseId,
    escrowAddress: args.escrow,
    escrowCaseId: args.escrowCaseId,
    partyA: args.partyA,
    partyB: args.partyB,
    feeToken: args.feeToken,
    amount: args.amount,
    panelSize: 0, // unknown at request time; CaseOpened will fill in panel size
  })
}

// `client` is the unbranded PublicClient — viem's full type is
// parameterised by chain attachment and we don't want to leak that
// through this internal API.
async function applyCaseOpened(
  cfg: IndexerConfig,
  client: PublicClient,
  args: ArgsFor<"CaseOpened">,
  _txHash: Hex,
) {
  // CaseOpened no longer carries a panel array — the original arbiter
  // is drawn separately by VRF and announced via ArbiterDrawn.
  // Pull deadlines from chain since they're not on the event payload.
  const c = await client.readContract({
    address: cfg.aegisAddress,
    abi: aegisAbi,
    functionName: "getCase",
    args: [args.caseId],
  })
  const deadlineCommit = new Date(Number(c.originalCommitDeadline) * 1000)
  const deadlineReveal = new Date(Number(c.originalRevealDeadline) * 1000)
  const arbiterPanel: { address: Address; seat: number }[] =
    c.originalArbiter !== zeroAddress
      ? [{ address: c.originalArbiter, seat: 0 }]
      : []

  await recordCaseOpened({
    chainId: cfg.chainId,
    aegisAddress: cfg.aegisAddress,
    caseId: args.caseId,
    escrowAddress: args.escrow,
    escrowCaseId: args.escrowCaseId,
    partyA: args.partyA,
    partyB: args.partyB,
    feeToken: args.feeToken,
    amount: args.amount,
    panelSize: arbiterPanel.length,
    deadlineCommit,
    deadlineReveal,
    panel: arbiterPanel,
  })
}

/// Arbiter assigned to a slot — original OR appeal. Phase-agnostic by
/// design (de novo). Determines the slot from the existing panelMembers
/// state for this case:
/// - 0 active originals  ⇒ initial original draw (phase='original', seat 0)
/// - 1 active original, not yet revealed ⇒ stall round-0 redraw — mark
///   old as 'redrawn', insert new original at seat 0
/// - 1 active original, revealed ⇒ appeal slot — count active appeal
///   members to assign seat 0 or 1
async function applyArbiterDrawn(
  cfg: IndexerConfig,
  args: ArgsFor<"ArbiterDrawn">,
) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return

  const arbiter = args.arbiter.toLowerCase()

  const activeOriginals = await db
    .select({
      panelistAddress: schema.panelMembers.panelistAddress,
      revealedAt: schema.panelMembers.revealedAt,
    })
    .from(schema.panelMembers)
    .where(
      and(
        eq(schema.panelMembers.caseUuid, caseUuid),
        eq(schema.panelMembers.phase, "original"),
        sql`${schema.panelMembers.leftAt} IS NULL`,
      ),
    )

  let phase: "original" | "appeal" = "original"
  let seat = 0

  if (activeOriginals.length > 0) {
    const og = activeOriginals[0]
    if (og.revealedAt !== null) {
      phase = "appeal"
      const activeAppeals = await db
        .select({ panelistAddress: schema.panelMembers.panelistAddress })
        .from(schema.panelMembers)
        .where(
          and(
            eq(schema.panelMembers.caseUuid, caseUuid),
            eq(schema.panelMembers.phase, "appeal"),
            sql`${schema.panelMembers.leftAt} IS NULL`,
          ),
        )
      seat = activeAppeals.length
    } else if (og.panelistAddress.toLowerCase() !== arbiter) {
      // Stall round-0 redraw: original hasn't revealed and a different
      // arbiter is being drawn. Mark the old original as 'redrawn'.
      // Scope the update to the active row so a replay of this log
      // doesn't overwrite a leftAt set on the first pass.
      await db
        .update(schema.panelMembers)
        .set({ leftAt: new Date(), leftReason: "redrawn" })
        .where(
          and(
            eq(schema.panelMembers.caseUuid, caseUuid),
            eq(schema.panelMembers.panelistAddress, og.panelistAddress),
            sql`${schema.panelMembers.leftAt} IS NULL`,
          ),
        )
    }
    // If activeOriginals[0].panelistAddress === arbiter and no reveal,
    // this is a re-emission for the same arbiter — onConflictDoNothing
    // below makes it idempotent.
  }

  await db
    .insert(schema.panelMembers)
    .values({
      caseUuid,
      panelistAddress: arbiter,
      seat,
      phase,
    })
    .onConflictDoNothing()
}

/// Voluntary recusal — replace `previousArbiter` with `replacement` at
/// the same phase + seat. Marks the previous row as left with reason
/// 'recused' (vs 'redrawn' for stall).
async function applyArbiterRedrawn(
  cfg: IndexerConfig,
  args: ArgsFor<"ArbiterRedrawn">,
) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return

  const previous = args.previousArbiter.toLowerCase()
  const replacement = args.replacement.toLowerCase()

  // Scope the lookup to the active row so a log replay no-ops
  // instead of overwriting the leftAt timestamp on the already-left
  // panelist. The matching update below also filters on leftAt
  // IS NULL for the same reason.
  const prev = await db.query.panelMembers.findFirst({
    where: (m, { and: a, eq: e, isNull }) =>
      a(
        e(m.caseUuid, caseUuid),
        e(m.panelistAddress, previous),
        isNull(m.leftAt),
      ),
    columns: { phase: true, seat: true },
  })
  if (!prev) return

  await db
    .update(schema.panelMembers)
    .set({ leftAt: new Date(), leftReason: "recused" })
    .where(
      and(
        eq(schema.panelMembers.caseUuid, caseUuid),
        eq(schema.panelMembers.panelistAddress, previous),
        sql`${schema.panelMembers.leftAt} IS NULL`,
      ),
    )

  await db
    .insert(schema.panelMembers)
    .values({
      caseUuid,
      panelistAddress: replacement,
      seat: prev.seat,
      phase: prev.phase as "original" | "appeal",
    })
    .onConflictDoNothing()
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

async function applyCommitted(
  cfg: IndexerConfig,
  args: ArgsFor<"Committed">,
  _txHash: Hex,
) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  // Phase-agnostic: under de novo, the same Committed event fires for
  // original and appeal arbiters. Match by (caseUuid, arbiter) — the
  // primary key guarantees a single matching row regardless of phase.
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
          args.arbiter.toLowerCase(),
        ),
      ),
    )
}

async function applyRevealed(
  cfg: IndexerConfig,
  client: PublicClient,
  args: ArgsFor<"Revealed">,
) {
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
          args.arbiter.toLowerCase(),
        ),
      ),
    )
  // The contract's state machine moves the case forward when an arbiter
  // reveals — original reveal flips Voting → AppealableResolved, the
  // last appeal-slot reveal flips Voting → AppealableResolved again
  // (with the median computed). The Revealed event alone doesn't carry
  // that transition, so we read getCase() and translate the on-chain
  // state to its DB-status equivalent. Cheaper than maintaining a
  // separate state-tracker; correctness is checked by the e2e harness.
  const view = await client.readContract({
    address: cfg.aegisAddress,
    abi: aegisAbi,
    functionName: "getCase",
    args: [args.caseId],
  })
  // CaseState enum: None=0, AwaitingArbiter=1, Voting=2,
  // AppealableResolved=3, AwaitingAppealPanel=4, Resolved=5,
  // Defaulted=6, Canceled=7.
  const stateToStatus: Record<number, "open" | "revealing" | "appealable_resolved" | "resolved"> = {
    2: "revealing", // still in Voting after a partial reveal
    3: "appealable_resolved",
    5: "resolved",
  }
  const next = stateToStatus[view.state]
  if (!next) return
  await db
    .update(schema.cases)
    .set({
      status: next,
      ...(next === "appealable_resolved"
        ? { medianPercentage: Number(args.partyAPercentage) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.cases.id, caseUuid))
}

async function applyCaseResolved(
  cfg: IndexerConfig,
  args: ArgsFor<"CaseResolved">,
  txHash: Hex,
) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  // CaseResolved emits finalPercentage + finalDigest. Pre-typed-args
  // this code read `medianPercentage`, which the event doesn't have —
  // a silent undefined coerced to NaN by Number() and then "fixed" by
  // a `?? 50` fallback. Now the field name is checked at the type
  // level.
  await recordResolution({
    caseUuid,
    status: "resolved",
    medianPercentage: args.finalPercentage,
    finalDigest: args.finalDigest,
    resolutionTxHash: txHash,
  })
}

async function applyCaseDefaultResolved(
  cfg: IndexerConfig,
  args: ArgsFor<"CaseDefaultResolved">,
  txHash: Hex,
) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  await recordResolution({
    caseUuid,
    status: "default_resolved",
    medianPercentage: args.fallbackPercentage,
    // Default resolution has no verdict digest (no arbiter signed off).
    finalDigest: "0x",
    resolutionTxHash: txHash,
  })
}

async function applyStatusUpdate(
  cfg: IndexerConfig,
  caseIdHex: Hex,
  status: "appeal_awaiting_panel",
) {
  const caseUuid = await findCaseUuid(cfg, caseIdHex)
  if (!caseUuid) return
  await db
    .update(schema.cases)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.cases.id, caseUuid))
}

async function applyRecused(
  cfg: IndexerConfig,
  args: ArgsFor<"Recused">,
) {
  const caseUuid = await findCaseUuid(cfg, args.caseId)
  if (!caseUuid) return
  const replacement = args.replacement.toLowerCase()
  const recused = args.recused.toLowerCase()

  // The Recused event doesn't carry a seat number — it's keyed by
  // (caseId, recused, replacement). Look up the recused panelist's
  // active row to recover the seat (same approach as
  // applyArbiterRedrawn). Pre-typed-args this read `args.seat`, which
  // was always undefined and coerced to NaN; new rows were inserted
  // with NaN as their seat. The leftAt IS NULL filter makes the
  // handler a no-op on replay.
  const prev = await db.query.panelMembers.findFirst({
    where: (m, { and: a, eq: e, isNull }) =>
      a(
        e(m.caseUuid, caseUuid),
        e(m.panelistAddress, recused),
        isNull(m.leftAt),
      ),
    columns: { seat: true, phase: true },
  })
  if (!prev) return

  // Mark the recused panelist as left (rather than deleting) so the audit
  // trail survives. Insert the replacement as a new row at the same seat.
  await db
    .update(schema.panelMembers)
    .set({ leftAt: new Date(), leftReason: "recused" })
    .where(
      and(
        eq(schema.panelMembers.caseUuid, caseUuid),
        eq(schema.panelMembers.panelistAddress, recused),
        sql`${schema.panelMembers.leftAt} IS NULL`,
      ),
    )
  await db
    .insert(schema.panelMembers)
    .values({
      caseUuid,
      panelistAddress: replacement,
      seat: prev.seat,
      phase: prev.phase as "original" | "appeal",
    })
    .onConflictDoNothing()
}

async function applyArbiterRegistered(
  cfg: IndexerConfig,
  args: ArgsFor<"ArbiterRegistered">,
) {
  const addr = args.arbiter.toLowerCase()
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

async function applyArbiterRevoked(
  cfg: IndexerConfig,
  args: ArgsFor<"ArbiterRevoked">,
) {
  const addr = args.arbiter.toLowerCase()
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

async function applyStakeChange(
  cfg: IndexerConfig,
  args: ArgsFor<"StakeIncreased"> | ArgsFor<"StakeWithdrawn">,
) {
  const addr = args.arbiter.toLowerCase()
  await db
    .update(schema.arbiters)
    .set({
      stakedAmount: args.newTotal.toString(),
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
