import "server-only"
import { eq, and, desc, sql } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"

export interface ArbiterCaseSummary {
  caseUuid: string
  caseId: string
  chainId: number
  status: string
  seat: number
  committedAt: Date | null
  revealedAt: Date | null
  partyAPercentage: number | null
  rationaleDigest: string | null
  /** True iff the case has resolved on-chain — gates whether we expose vote details. */
  caseResolved: boolean
  resolvedAt: Date | null
  medianPercentage: number | null
  leftAt: Date | null
  leftReason: string | null // 'recused' | 'redrawn' | null
}

export interface ArbiterProfile {
  address: string
  rosterByChain: Array<{
    chainId: number
    status: "active" | "revoked"
    stakedAmount: string
    caseCount: number
    credentialCID: string | null
    registeredAt: Date
  }>
  totalsByChain: Array<{
    chainId: number
    casesOnPanel: number
    cleanReveals: number
    nonReveals: number
  }>
  cases: ArbiterCaseSummary[]
  declaredConflicts: Array<{
    chainId: number
    partyAddress: string
    reason: string | null
    declaredAt: Date
  }>
}

const lower = (a: string) => a.toLowerCase()

export async function readArbiterProfile(addressInput: string): Promise<ArbiterProfile> {
  const address = lower(addressInput)

  // Roster rows for this address across chains.
  const rosterRows = await db.query.arbiters.findMany({
    where: eq(schema.arbiters.address, address),
    orderBy: (a, { asc }) => [asc(a.chainId)],
  })

  const declaredRows = await db.query.arbiterConflicts.findMany({
    where: eq(schema.arbiterConflicts.arbiterAddress, address),
    orderBy: (c, { desc }) => [desc(c.declaredAt)],
  })

  // All panel-member rows for this address — joined to cases for context.
  const panelRows = await db
    .select({
      caseUuid: schema.panelMembers.caseUuid,
      seat: schema.panelMembers.seat,
      committedAt: schema.panelMembers.committedAt,
      revealedAt: schema.panelMembers.revealedAt,
      partyAPercentage: schema.panelMembers.partyAPercentage,
      rationaleDigest: schema.panelMembers.rationaleDigest,
      leftAt: schema.panelMembers.leftAt,
      leftReason: schema.panelMembers.leftReason,
      caseId: schema.cases.caseId,
      chainId: schema.cases.chainId,
      status: schema.cases.status,
      resolvedAt: schema.cases.resolvedAt,
      medianPercentage: schema.cases.medianPercentage,
    })
    .from(schema.panelMembers)
    .innerJoin(
      schema.cases,
      eq(schema.panelMembers.caseUuid, schema.cases.id),
    )
    .where(eq(schema.panelMembers.panelistAddress, address))
    .orderBy(desc(schema.cases.openedAt))
    .limit(200)

  const cases: ArbiterCaseSummary[] = panelRows.map((r) => {
    const caseResolved =
      r.status === "resolved" || r.status === "default_resolved"
    return {
      caseUuid: r.caseUuid,
      caseId: r.caseId,
      chainId: r.chainId,
      status: r.status,
      seat: r.seat,
      committedAt: r.committedAt ?? null,
      revealedAt: r.revealedAt ?? null,
      // Hide pre-resolution vote details — public ledger reveals only after
      // the case has finalized to avoid giving away in-flight panel signals.
      partyAPercentage: caseResolved ? r.partyAPercentage ?? null : null,
      rationaleDigest: caseResolved ? r.rationaleDigest ?? null : null,
      caseResolved,
      resolvedAt: r.resolvedAt ?? null,
      medianPercentage: r.medianPercentage ?? null,
      leftAt: r.leftAt ?? null,
      leftReason: r.leftReason ?? null,
    }
  })

  // Reveal stats per chain — only count cases the arbiter actually sat on
  // through to resolution. Recused / redrawn rows are still counted in the
  // history list but not in the reveal-rate denominator, since the panelist
  // wasn't expected to reveal once they left.
  const totalsMap = new Map<number, { casesOnPanel: number; cleanReveals: number; nonReveals: number }>()
  for (const c of cases) {
    if (!c.caseResolved) continue
    if (c.leftAt) continue
    const t = totalsMap.get(c.chainId) ?? {
      casesOnPanel: 0,
      cleanReveals: 0,
      nonReveals: 0,
    }
    t.casesOnPanel += 1
    if (c.revealedAt) t.cleanReveals += 1
    else t.nonReveals += 1
    totalsMap.set(c.chainId, t)
  }

  return {
    address,
    rosterByChain: rosterRows.map((r) => ({
      chainId: r.chainId,
      status: r.status,
      stakedAmount: r.stakedAmount,
      caseCount: r.caseCount,
      credentialCID: r.credentialCID ?? null,
      registeredAt: r.registeredAt,
    })),
    totalsByChain: Array.from(totalsMap.entries()).map(([chainId, t]) => ({
      chainId,
      ...t,
    })),
    cases,
    declaredConflicts: declaredRows.map((r) => ({
      chainId: r.chainId,
      partyAddress: r.partyAddress,
      reason: r.reason ?? null,
      declaredAt: r.declaredAt,
    })),
  }
}

// Suppress lint: `sql` isn't currently used but kept imported in case the
// query expands to aggregate-only stats.
void sql
void and
