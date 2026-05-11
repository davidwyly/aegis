import Link from "next/link"
import { listLedger, type ListLedgerInput } from "@/lib/cases/service"
import { CaseStatusBadge } from "@/components/case-status-badge"
import { getExplorerAddressUrl } from "@/lib/chains"

// Server-render per request — the DB row set changes as the keeper indexes
// new cases; static prerender would serve stale data forever.
export const dynamic = "force-dynamic"

const VALID_STATUSES = [
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
] as const
type Status = (typeof VALID_STATUSES)[number]

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

// "Xm ago" / "Xh ago" / "Xd ago" — server-rendered, refreshes on
// each request. Cases older than 30d show the date.
function relativeTime(d: Date | string, now: number): string {
  const ms = now - new Date(d).getTime()
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return "just now"
  if (totalMin < 60) return `${totalMin}m ago`
  const totalHr = Math.floor(totalMin / 60)
  if (totalHr < 24) return `${totalHr}h ago`
  const totalDay = Math.floor(totalHr / 24)
  if (totalDay < 30) return `${totalDay}d ago`
  return new Date(d).toLocaleDateString()
}

export default async function CasesLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[]; chain?: string; cursor?: string }>
}) {
  const sp = await searchParams
  const statusInput = Array.isArray(sp.status) ? sp.status : sp.status ? [sp.status] : []
  const status = statusInput.filter((s): s is Status =>
    (VALID_STATUSES as readonly string[]).includes(s),
  )
  const chainId = sp.chain ? Number(sp.chain) : undefined
  const cursor = sp.cursor ?? null

  const filterInput: ListLedgerInput = {
    chainId: chainId && Number.isFinite(chainId) ? chainId : undefined,
    status: status.length > 0 ? status : undefined,
    cursor,
  }

  let rows: Awaited<ReturnType<typeof listLedger>>["rows"] = []
  let nextCursor: string | null = null
  let dbError: string | null = null
  try {
    const result = await listLedger(filterInput)
    rows = result.rows
    nextCursor = result.nextCursor
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  // Build the next-page URL preserving filters.
  const renderNow = Date.now()

  const buildUrl = (cur: string | null) => {
    const usp = new URLSearchParams()
    for (const s of status) usp.append("status", s)
    if (chainId) usp.set("chain", String(chainId))
    if (cur) usp.set("cursor", cur)
    const q = usp.toString()
    return q ? `/cases?${q}` : "/cases"
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cases</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Public ledger of every dispute Aegis has accepted, in flight or
          resolved. Briefs and rationales are private until resolution.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3 text-sm" method="get">
        <fieldset>
          <legend className="block text-xs text-zinc-500">Status</legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {VALID_STATUSES.map((s) => (
              <label key={s} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  name="status"
                  value={s}
                  defaultChecked={status.includes(s)}
                />
                <span className="text-xs">{s}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="block text-xs text-zinc-500">Chain ID</span>
          <input
            name="chain"
            defaultValue={chainId ?? ""}
            placeholder="any"
            className="input mt-1 w-24"
          />
        </label>
        <button type="submit" className="btn-primary text-xs">
          Apply filters
        </button>
        {(status.length > 0 || chainId !== undefined) && (
          <Link href="/cases" className="text-xs text-zinc-500 hover:underline">
            Clear
          </Link>
        )}
      </form>

      {dbError && (
        <div className="card border-rose-300 bg-rose-50 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
          DB unavailable: {dbError}
        </div>
      )}

      {!dbError && rows.length === 0 && (
        <div className="card text-sm text-zinc-600 dark:text-zinc-400">
          {cursor || status.length > 0 || chainId !== undefined
            ? "No cases match those filters."
            : "No cases yet. The keeper opens a case here when an escrow protocol flips a dispute to "}
          {!cursor && status.length === 0 && chainId === undefined && (
            <code className="font-mono">Disputed</code>
          )}
          {!cursor && status.length === 0 && chainId === undefined && "."}
        </div>
      )}

      <ul className="space-y-2">
        {rows.map((c) => (
          <li key={c.id}>
            <Link href={`/cases/${c.id}`} className="card flex items-center gap-4 hover:border-zinc-400">
              <CaseStatusBadge status={c.status} />
              <div className="grow">
                <div className="font-mono text-xs text-zinc-500">
                  {c.caseId.slice(0, 14)}…
                </div>
                <div className="text-sm">
                  <span className="font-mono">{shortAddr(c.partyA)}</span>{" "}
                  vs{" "}
                  <span className="font-mono">{shortAddr(c.partyB)}</span>
                  {" · "}
                  <a
                    href={getExplorerAddressUrl(c.chainId, c.escrowAddress)}
                    className="hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    escrow {shortAddr(c.escrowAddress)}
                  </a>
                </div>
              </div>
              <div className="text-right text-xs text-zinc-500">
                <div className="font-mono text-sm text-zinc-700 dark:text-zinc-300">
                  {c.amount}
                </div>
                <div>{relativeTime(c.openedAt, renderNow)}</div>
                <div>
                  r{c.round} · panel {c.panelSize}
                </div>
                {c.medianPercentage !== null && (
                  <div>verdict {c.medianPercentage}/100</div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {nextCursor && (
        <div className="flex justify-center">
          <Link href={buildUrl(nextCursor)} className="btn-secondary text-xs">
            Older cases →
          </Link>
        </div>
      )}
    </div>
  )
}
