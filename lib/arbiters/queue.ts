import "server-only"
import { eq, and, isNull, inArray, desc } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"

export interface QueueItem {
  caseUuid: string
  caseId: string
  chainId: number
  status: string
  phase: "original" | "appeal"
  seat: number
  deadlineCommit: Date | null
  deadlineReveal: Date | null
  committedAt: Date | null
  revealedAt: Date | null
  partyA: string
  partyB: string
}

const lower = (a: string) => a.toLowerCase()

type ActiveStatus =
  | "awaiting_panel"
  | "open"
  | "revealing"
  | "appealable_resolved"
  | "appeal_awaiting_panel"
  | "appeal_open"
  | "appeal_revealing"

const ACTIVE_STATUSES: ActiveStatus[] = [
  "awaiting_panel",
  "open",
  "revealing",
  "appealable_resolved",
  "appeal_awaiting_panel",
  "appeal_open",
  "appeal_revealing",
]

/**
 * Cases the given address is currently sitting on as a panelist —
 * either the original or the appeal phase. Excludes recused/redrawn
 * rows and cases that have already terminally resolved.
 */
export async function listQueueFor(address: string): Promise<QueueItem[]> {
  const addr = lower(address)
  const rows = await db
    .select({
      caseUuid: schema.panelMembers.caseUuid,
      seat: schema.panelMembers.seat,
      phase: schema.panelMembers.phase,
      committedAt: schema.panelMembers.committedAt,
      revealedAt: schema.panelMembers.revealedAt,
      caseId: schema.cases.caseId,
      chainId: schema.cases.chainId,
      status: schema.cases.status,
      deadlineCommit: schema.cases.deadlineCommit,
      deadlineReveal: schema.cases.deadlineReveal,
      partyA: schema.cases.partyA,
      partyB: schema.cases.partyB,
    })
    .from(schema.panelMembers)
    .innerJoin(schema.cases, eq(schema.panelMembers.caseUuid, schema.cases.id))
    .where(
      and(
        eq(schema.panelMembers.panelistAddress, addr),
        isNull(schema.panelMembers.leftAt),
        inArray(schema.cases.status, ACTIVE_STATUSES),
      ),
    )
    .orderBy(desc(schema.cases.openedAt))

  return rows.map((r) => ({
    caseUuid: r.caseUuid,
    caseId: r.caseId,
    chainId: r.chainId,
    status: r.status,
    phase: (r.phase as "original" | "appeal") ?? "original",
    seat: r.seat,
    deadlineCommit: r.deadlineCommit ?? null,
    deadlineReveal: r.deadlineReveal ?? null,
    committedAt: r.committedAt ?? null,
    revealedAt: r.revealedAt ?? null,
    partyA: r.partyA,
    partyB: r.partyB,
  }))
}
