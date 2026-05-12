import { NextResponse } from "next/server"
import { listLedger, MAX_LIMIT } from "@/lib/cases/service"
import { getSession } from "@/lib/auth/session"
import {
  isArbiterSafeCaseStatus,
  isResolvedCaseStatus,
  rawStatusesMatchingSanitized,
  sanitizeStatusForArbiter,
  type ArbiterSafeCaseStatus,
  type CaseStatus,
} from "@/lib/cases/status"

// Postgres `integer` is signed 32-bit. The `cases.chain_id` column
// uses that type, so larger values would pass a basic positive-int
// check and then 500 in the SQL layer.
const MAX_INT32 = 2_147_483_647

// Parse a query-param string as a positive integer bounded above by
// `max`. Returns `undefined` for a missing param so the caller falls
// through to listLedger's default; returns `null` for invalid input
// so the caller can 400 explicitly rather than letting NaN / overflow
// propagate into the SQL layer.
function parsePositiveInt(
  raw: string | null,
  max: number,
): number | null | undefined {
  if (raw === null) return undefined
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n <= max ? n : null
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const chainId = parsePositiveInt(url.searchParams.get("chainId"), MAX_INT32)
  // Use listLedger's exported MAX_LIMIT so the route's contract and
  // the service's actual cap stay in lockstep.
  const limit = parsePositiveInt(url.searchParams.get("limit"), MAX_LIMIT)
  const cursor = url.searchParams.get("cursor")
  const statusParam = url.searchParams.getAll("status")

  if (chainId === null) {
    return NextResponse.json(
      { error: "chainId must be a positive integer ≤ 2147483647" },
      { status: 400 },
    )
  }
  if (limit === null) {
    return NextResponse.json(
      { error: `limit must be a positive integer ≤ ${MAX_LIMIT}` },
      { status: 400 },
    )
  }

  // The filter vocabulary is the arbiter-safe vocabulary — any
  // `appeal_*` value (and any unknown string) is rejected. The
  // valid subset is kept; if the caller passed only invalid values
  // the request still asked to NARROW the result, so honor that
  // narrowing intent with an empty response rather than silently
  // returning the unfiltered ledger. Accepted values are expanded
  // to every raw `CaseStatus` that sanitizes to them (e.g. `open`
  // → both raw `open` and raw `appeal_open`), so filtering by
  // `?status=open` covers original-phase AND appeal-phase commit
  // cases.
  const safeStatuses: ArbiterSafeCaseStatus[] = statusParam.filter(
    isArbiterSafeCaseStatus,
  )

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
    chainId,
    limit,
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
