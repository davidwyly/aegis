import { NextResponse } from "next/server"
import { listLedger } from "@/lib/cases/service"
import { CASE_STATUSES, type CaseStatus } from "@/lib/db/schema"

const VALID_STATUSES = new Set<string>(CASE_STATUSES)

export async function GET(req: Request) {
  const url = new URL(req.url)
  const chainId = url.searchParams.get("chainId")
  const limit = url.searchParams.get("limit")
  const cursor = url.searchParams.get("cursor")
  const statusParam = url.searchParams.getAll("status")
  const status = statusParam.filter((s): s is CaseStatus =>
    VALID_STATUSES.has(s),
  )

  const { rows, nextCursor } = await listLedger({
    chainId: chainId ? Number(chainId) : undefined,
    limit: limit ? Number(limit) : undefined,
    cursor: cursor ?? null,
    status: status.length > 0 ? status : undefined,
  })
  return NextResponse.json({ cases: rows, nextCursor })
}
