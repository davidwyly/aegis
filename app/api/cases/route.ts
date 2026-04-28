import { NextResponse } from "next/server"
import { listLedger } from "@/lib/cases/service"

const VALID_STATUSES = new Set([
  "awaiting_panel",
  "open",
  "revealing",
  "appealable_resolved",
  "appeal_awaiting_panel",
  "appeal_open",
  "appeal_revealing",
  "resolved",
  "default_resolved",
  "stalled",
])

type Status =
  | "awaiting_panel"
  | "open"
  | "revealing"
  | "appealable_resolved"
  | "appeal_awaiting_panel"
  | "appeal_open"
  | "appeal_revealing"
  | "resolved"
  | "default_resolved"
  | "stalled"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const chainId = url.searchParams.get("chainId")
  const limit = url.searchParams.get("limit")
  const cursor = url.searchParams.get("cursor")
  const statusParam = url.searchParams.getAll("status")
  const status = statusParam.filter((s): s is Status => VALID_STATUSES.has(s))

  const { rows, nextCursor } = await listLedger({
    chainId: chainId ? Number(chainId) : undefined,
    limit: limit ? Number(limit) : undefined,
    cursor: cursor ?? null,
    status: status.length > 0 ? status : undefined,
  })
  return NextResponse.json({ cases: rows, nextCursor })
}
