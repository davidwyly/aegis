import "server-only"
import { eq, and, isNull, inArray, desc } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"
import {
  CASE_STATUSES,
  sanitizeStatusForArbiter,
  type ArbiterSafeCaseStatus,
  type CaseStatus,
} from "@/lib/cases/status"

// De novo blindness: the queue is arbiter-facing by definition, so
// the response shape never carries `phase`, and `status` is the
// arbiter-safe variant — the type system rejects any attempt to
// write a raw `appeal_*` value into this field.
export interface QueueItem {
  caseUuid: string
  caseId: string
  chainId: number
  status: ArbiterSafeCaseStatus
  seat: number
  deadlineCommit: Date | null
  deadlineReveal: Date | null
  committedAt: Date | null
  revealedAt: Date | null
  partyA: string
  partyB: string
}

const lower = (a: string) => a.toLowerCase()

// Statuses where an arbiter row might still be live — i.e., where it
// belongs in the queue. We filter on raw statuses in SQL, then
// sanitize on the way out.
const ACTIVE_STATUSES: CaseStatus[] = CASE_STATUSES.filter(
  (s) => s !== "resolved" && s !== "default_resolved" && s !== "stalled",
)

/**
 * Cases the given address is currently sitting on as a panelist.
 * Excludes recused/redrawn rows and terminally-resolved cases.
 *
 * Status values are collapsed via `sanitizeStatusForArbiter` so the
 * caller cannot infer whether they're on the original or the appeal
 * phase. The internal `phase` column is intentionally NOT projected.
 */
export async function listQueueFor(address: string): Promise<QueueItem[]> {
  const addr = lower(address)
  const rows = await db
    .select({
      caseUuid: schema.panelMembers.caseUuid,
      seat: schema.panelMembers.seat,
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
    status: sanitizeStatusForArbiter(r.status as CaseStatus),
    seat: r.seat,
    deadlineCommit: r.deadlineCommit ?? null,
    deadlineReveal: r.deadlineReveal ?? null,
    committedAt: r.committedAt ?? null,
    revealedAt: r.revealedAt ?? null,
    partyA: r.partyA,
    partyB: r.partyB,
  }))
}
