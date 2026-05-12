import "server-only"
import { and, eq } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"
import { isResolvedCaseStatus } from "@/lib/db/schema"

/**
 * Three-class visibility for case-scoped private content (briefs +
 * evidence). The rule is the same for both:
 *
 *   - "none": viewer cannot read any rows (unauthenticated, or
 *             pre-resolution non-stakeholder)
 *   - "own":  pre-resolution party — sees only their own contributions
 *   - "all":  panelist (any time), OR any authenticated viewer once
 *             the case is resolved (briefs + evidence become a public
 *             record alongside the on-chain verdict)
 *
 * `stalled` cases are NOT treated as resolved — no verdict on file
 * means a party still only sees their own contributions.
 *
 * Returns "none" if the case does not exist, so callers don't have to
 * special-case missing rows.
 */
export type ViewerVisibility = "none" | "own" | "all"

export async function resolveViewerVisibility(
  caseUuid: string,
  viewer: `0x${string}` | null,
): Promise<ViewerVisibility> {
  if (!viewer) return "none"
  const v = viewer.toLowerCase()

  const caseRow = await db.query.cases.findFirst({
    where: eq(schema.cases.id, caseUuid),
  })
  if (!caseRow) return "none"

  if (isResolvedCaseStatus(caseRow.status)) return "all"

  const isParty =
    v === caseRow.partyA.toLowerCase() || v === caseRow.partyB.toLowerCase()
  if (isParty) return "own"

  const panel = await db.query.panelMembers.findFirst({
    where: and(
      eq(schema.panelMembers.caseUuid, caseUuid),
      eq(schema.panelMembers.panelistAddress, v),
    ),
  })
  return panel ? "all" : "none"
}
