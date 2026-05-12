import { NextResponse } from "next/server"
import {
  getCaseById,
  getPanel,
  listBriefsForViewer,
} from "@/lib/cases/service"
import { getSession } from "@/lib/auth/session"
import {
  isResolvedCaseStatus,
  sanitizeStatusForArbiter,
} from "@/lib/cases/status"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const caseRow = await getCaseById(id)
  if (!caseRow) return NextResponse.json({ error: "not found" }, { status: 404 })

  const session = await getSession()
  const viewer = session.address ?? null

  // De novo: this endpoint defaults to the arbiter-safe shape (no
  // phase leakage in `case.status`, empty `panel` listing). The full
  // raw shape is returned only when one of these is true:
  //   - the viewer is a party on this case (they need raw phase info)
  //   - the case is post-resolution (public record; nothing left to hide)
  //
  // We DON'T gate sanitization on "the viewer happens to be an
  // assigned arbiter" — an arbiter could just clear cookies and
  // re-query, so the default for everyone-not-a-party is the safe
  // shape. The contract excludes parties from being drawn, so the
  // party branch is never reached by an assigned arbiter on the
  // same case.
  const viewerLower = viewer?.toLowerCase() ?? null
  const isParty =
    viewerLower !== null &&
    (viewerLower === caseRow.partyA.toLowerCase() ||
      viewerLower === caseRow.partyB.toLowerCase())
  const isResolved = isResolvedCaseStatus(caseRow.status)
  const showRaw = isParty || isResolved

  const responseCase = showRaw
    ? caseRow
    : {
        ...caseRow,
        status: sanitizeStatusForArbiter(caseRow.status),
        // `deadlineCommit` / `deadlineReveal` only track the
        // ORIGINAL phase's deadlines today — the indexer doesn't
        // mirror the contract's `appealCommitDeadline` /
        // `appealRevealDeadline` after the appeal panel is seated.
        // A consumer who sees `status: "open"` with deadlines long
        // past could infer this is an appeal case, defeating the
        // status sanitization. Null them out until the indexer
        // tracks per-phase deadlines (separate follow-up).
        deadlineCommit: null,
        deadlineReveal: null,
      }

  const panel = showRaw ? await getPanel(caseRow.id) : []
  const briefs = await listBriefsForViewer(caseRow.id, viewer)

  return NextResponse.json({
    case: responseCase,
    panel,
    briefs,
    viewer,
  })
}
