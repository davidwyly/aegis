import "server-only"
import { eq } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"

export type TimelineEventKind =
  | "case_opened"
  | "panelist_joined"
  | "panelist_committed"
  | "panelist_revealed"
  | "panelist_left"
  | "brief_first_submitted"
  | "brief_updated"
  | "evidence_uploaded"
  | "case_resolved"

export interface TimelineEvent {
  kind: TimelineEventKind
  at: Date
  actor: string | null // 0x address when applicable
  /** Subject of the event — varies by kind. */
  detail: Record<string, unknown>
}

interface TimelineOptions {
  /**
   * Whether the viewer should see vote details + brief/evidence-author
   * details before resolution. Public callers pass `false`; party / panel
   * / post-resolution viewers pass `true`.
   */
  includePrivate: boolean
}

/**
 * Pulls every event we have a timestamp for and orders them. Used by the
 * /cases/[id] page to show "what happened" without observers needing to
 * piece it together from on-chain events.
 */
export async function assembleTimeline(
  caseUuid: string,
  opts: TimelineOptions = { includePrivate: false },
): Promise<TimelineEvent[]> {
  const c = await db.query.cases.findFirst({
    where: eq(schema.cases.id, caseUuid),
  })
  if (!c) return []

  const events: TimelineEvent[] = []

  events.push({
    kind: "case_opened",
    at: c.openedAt,
    actor: null,
    detail: {
      caseId: c.caseId,
      escrowAddress: c.escrowAddress,
      partyA: c.partyA,
      partyB: c.partyB,
      amount: c.amount,
      panelSize: c.panelSize,
    },
  })

  if (c.resolvedAt) {
    events.push({
      kind: "case_resolved",
      at: c.resolvedAt,
      actor: null,
      detail: {
        status: c.status,
        medianPercentage: c.medianPercentage,
        finalDigest: c.finalDigest,
        resolutionTxHash: c.resolutionTxHash,
      },
    })
  }

  const panelRows = await db.query.panelMembers.findMany({
    where: eq(schema.panelMembers.caseUuid, caseUuid),
  })
  const isResolved =
    c.status === "resolved" || c.status === "default_resolved"

  for (const p of panelRows) {
    if (p.joinedAt) {
      events.push({
        kind: "panelist_joined",
        at: p.joinedAt,
        actor: p.panelistAddress,
        detail: { seat: p.seat },
      })
    }
    if (p.committedAt) {
      events.push({
        kind: "panelist_committed",
        at: p.committedAt,
        actor: p.panelistAddress,
        detail: { seat: p.seat },
      })
    }
    if (p.revealedAt) {
      events.push({
        kind: "panelist_revealed",
        at: p.revealedAt,
        actor: p.panelistAddress,
        detail: {
          seat: p.seat,
          // Hide vote details until the case is resolved publicly, even
          // for panelists / parties — there's no legitimate reason for
          // them to see another panelist's revealed vote pre-resolution.
          partyAPercentage:
            isResolved || opts.includePrivate ? p.partyAPercentage : null,
          rationaleDigest: isResolved ? p.rationaleDigest : null,
        },
      })
    }
    if (p.leftAt && p.leftReason) {
      events.push({
        kind: "panelist_left",
        at: p.leftAt,
        actor: p.panelistAddress,
        detail: { seat: p.seat, reason: p.leftReason },
      })
    }
  }

  // Brief events: visibility mirrors the brief itself. The public timeline
  // gets the existence + role + timestamp, not the body.
  if (opts.includePrivate || isResolved) {
    const briefRows = await db.query.briefs.findMany({
      where: eq(schema.briefs.caseUuid, caseUuid),
    })
    for (const b of briefRows) {
      events.push({
        kind: "brief_first_submitted",
        at: b.submittedAt,
        actor: b.authorAddress,
        detail: { role: b.role },
      })
      if (b.updatedAt.getTime() !== b.submittedAt.getTime()) {
        events.push({
          kind: "brief_updated",
          at: b.updatedAt,
          actor: b.authorAddress,
          detail: { role: b.role },
        })
      }
    }
  }

  // Evidence events.
  if (opts.includePrivate || isResolved) {
    const evidenceRows = await db.query.evidenceFiles.findMany({
      where: eq(schema.evidenceFiles.caseUuid, caseUuid),
      columns: {
        uploaderAddress: true,
        role: true,
        fileName: true,
        size: true,
        mimeType: true,
        uploadedAt: true,
      },
    })
    for (const e of evidenceRows) {
      events.push({
        kind: "evidence_uploaded",
        at: e.uploadedAt,
        actor: e.uploaderAddress,
        detail: {
          role: e.role,
          fileName: e.fileName,
          size: e.size,
          mimeType: e.mimeType,
        },
      })
    }
  }

  events.sort((a, b) => a.at.getTime() - b.at.getTime())
  return events
}
