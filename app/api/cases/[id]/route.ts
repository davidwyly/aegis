import { NextResponse } from "next/server"
import { and, eq, isNull } from "drizzle-orm"
import { db, schema } from "@/lib/db/client"
import {
  getCaseById,
  getPanel,
  listBriefsForViewer,
} from "@/lib/cases/service"
import { getSession } from "@/lib/auth/session"
import {
  sanitizeStatusForArbiter,
  type CaseStatus,
} from "@/lib/cases/status"

async function isViewerAssignedArbiter(
  caseUuid: string,
  viewer: string,
): Promise<boolean> {
  const member = await db.query.panelMembers.findFirst({
    where: and(
      eq(schema.panelMembers.caseUuid, caseUuid),
      eq(schema.panelMembers.panelistAddress, viewer.toLowerCase()),
      isNull(schema.panelMembers.leftAt),
    ),
  })
  return !!member
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const caseRow = await getCaseById(id)
  if (!caseRow) return NextResponse.json({ error: "not found" }, { status: 404 })

  const session = await getSession()
  const viewer = session.address ?? null

  // De novo: an assigned arbiter must not learn from this endpoint
  // whether the case is in the original or appeal phase. We sanitize
  // the status, and omit the panel listing — its membership composition
  // (presence/absence of the original arbiter's address vs an appeal
  // arbiter's) would otherwise reveal which phase has been seated.
  // The contract excludes parties from being drawn, so a viewer is
  // never simultaneously a party and an assigned arbiter on the same
  // case; the order of these checks doesn't matter.
  const isAssignedArbiter =
    viewer !== null && (await isViewerAssignedArbiter(caseRow.id, viewer))

  const responseCase = isAssignedArbiter
    ? {
        ...caseRow,
        status: sanitizeStatusForArbiter(caseRow.status as CaseStatus),
      }
    : caseRow

  const panel = isAssignedArbiter ? [] : await getPanel(caseRow.id)
  const briefs = await listBriefsForViewer(caseRow.id, viewer)

  return NextResponse.json({
    case: responseCase,
    panel,
    briefs,
    viewer,
  })
}
