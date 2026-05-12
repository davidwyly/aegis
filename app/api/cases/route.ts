import { NextResponse } from "next/server"
import { listLedger } from "@/lib/cases/service"
import { getSession } from "@/lib/auth/session"
import {
  isArbiterSafeCaseStatus,
  isResolvedCaseStatus,
  rawStatusesMatchingSanitized,
  sanitizeStatusForArbiter,
  type ArbiterSafeCaseStatus,
  type CaseStatus,
} from "@/lib/cases/status"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const chainId = url.searchParams.get("chainId")
  const limit = url.searchParams.get("limit")
  const cursor = url.searchParams.get("cursor")
  const statusParam = url.searchParams.getAll("status")

  // The filter vocabulary is the arbiter-safe vocabulary — any
  // `appeal_*` value passed by the caller is silently dropped, not
  // honored. We then expand each accepted filter status to every
  // raw `CaseStatus` that sanitizes to it (e.g. `open` → both raw
  // `open` and raw `appeal_open`), so filtering by `?status=open`
  // covers original-phase AND appeal-phase commit cases.
  const safeStatuses: ArbiterSafeCaseStatus[] = statusParam.filter(
    isArbiterSafeCaseStatus,
  )

  // The caller asked to filter by status but every value they passed
  // was rejected (e.g. only `appeal_*`). Returning the unfiltered
  // ledger would be a surprising behaviour change — the request was
  // narrowing, not broadening. Honor the narrow intent with an empty
  // result instead of pretending the filter wasn't there.
  if (statusParam.length > 0 && safeStatuses.length === 0) {
    return NextResponse.json({ cases: [], nextCursor: null })
  }

  const rawStatuses: CaseStatus[] =
    safeStatuses.length > 0
      ? Array.from(
          new Set(safeStatuses.flatMap(rawStatusesMatchingSanitized)),
        )
      : []

  const { rows, nextCursor } = await listLedger({
    chainId: chainId ? Number(chainId) : undefined,
    limit: limit ? Number(limit) : undefined,
    cursor: cursor ?? null,
    status: rawStatuses.length > 0 ? rawStatuses : undefined,
  })

  // Default-safe response: each row's status is sanitized unless the
  // viewer is a party on that specific case, or the case is
  // post-resolution (public record). Same rule as `/api/cases/[id]`.
  // Deadlines are nulled in the sanitized branch for the same reason
  // — they only track the original phase today and would otherwise
  // reintroduce appeal inference.
  const session = await getSession()
  const viewerLower = session.address?.toLowerCase() ?? null
  const sanitizedRows = rows.map((row) => {
    const isParty =
      viewerLower !== null &&
      (viewerLower === row.partyA.toLowerCase() ||
        viewerLower === row.partyB.toLowerCase())
    if (isParty || isResolvedCaseStatus(row.status)) return row
    return {
      ...row,
      status: sanitizeStatusForArbiter(row.status),
      deadlineCommit: null,
      deadlineReveal: null,
    }
  })

  return NextResponse.json({ cases: sanitizedRows, nextCursor })
}
