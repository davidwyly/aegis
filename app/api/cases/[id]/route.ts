import { NextResponse } from "next/server"
import {
  getCaseById,
  getPanel,
  listBriefsForViewer,
} from "@/lib/cases/service"
import { getSession } from "@/lib/auth/session"

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const caseRow = await getCaseById(id)
  if (!caseRow) return NextResponse.json({ error: "not found" }, { status: 404 })

  const session = await getSession()
  const panel = await getPanel(caseRow.id)
  const briefs = await listBriefsForViewer(caseRow.id, session.address ?? null)

  return NextResponse.json({
    case: caseRow,
    panel,
    briefs,
    viewer: session.address ?? null,
  })
}
