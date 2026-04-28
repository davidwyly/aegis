import Link from "next/link"
import { listQueueFor } from "@/lib/arbiters/queue"
import { getSession } from "@/lib/auth/session"
import { CaseStatusBadge } from "@/components/case-status-badge"

export const dynamic = "force-dynamic"

function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function relTime(d: Date | null): string {
  if (!d) return "—"
  const ms = d.getTime() - Date.now()
  if (ms <= 0) return "passed"
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

export default async function QueuePage() {
  const session = await getSession()
  if (!session.address) {
    return (
      <div className="card text-sm text-zinc-600 dark:text-zinc-400">
        Sign in with your arbiter wallet to see your queue.
      </div>
    )
  }

  let items: Awaited<ReturnType<typeof listQueueFor>> = []
  let dbError: string | null = null
  try {
    items = await listQueueFor(session.address)
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My queue</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Cases you&apos;re on as a panelist (original + appeal phases).
          Recused / redrawn assignments are not shown.
        </p>
      </div>

      {dbError && (
        <div className="card border-rose-300 bg-rose-50 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
          DB unavailable: {dbError}
        </div>
      )}

      {!dbError && items.length === 0 && (
        <div className="card text-sm text-zinc-600 dark:text-zinc-400">
          You&apos;re not currently on any panels. New assignments land
          here automatically when VRF seats you.
        </div>
      )}

      {items.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="pb-2 pr-4 text-left font-normal">Status</th>
                <th className="pb-2 pr-4 text-left font-normal">Phase</th>
                <th className="pb-2 pr-4 text-left font-normal">Case</th>
                <th className="pb-2 pr-4 text-left font-normal">Parties</th>
                <th className="pb-2 pr-4 text-right font-normal">Seat</th>
                <th className="pb-2 pr-4 text-right font-normal">Commit by</th>
                <th className="pb-2 pr-4 text-right font-normal">Reveal by</th>
                <th className="pb-2 text-right font-normal">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const needsCommit =
                  (it.phase === "original" && it.status === "open" && !it.committedAt) ||
                  (it.phase === "appeal" && it.status === "appeal_open" && !it.committedAt)
                const needsReveal =
                  ((it.phase === "original" &&
                    (it.status === "open" || it.status === "revealing")) ||
                    (it.phase === "appeal" &&
                      (it.status === "appeal_open" || it.status === "appeal_revealing"))) &&
                  it.committedAt &&
                  !it.revealedAt
                return (
                  <tr
                    key={`${it.caseUuid}-${it.phase}`}
                    className="border-t border-zinc-200 dark:border-zinc-800"
                  >
                    <td className="py-2 pr-4">
                      <CaseStatusBadge status={it.status} />
                    </td>
                    <td className="py-2 pr-4 text-xs">{it.phase}</td>
                    <td className="py-2 pr-4">
                      <Link
                        href={`/cases/${it.caseUuid}`}
                        className="font-mono text-xs hover:underline"
                      >
                        {it.caseId.slice(0, 14)}…
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-xs font-mono">
                      {shortAddr(it.partyA)} vs {shortAddr(it.partyB)}
                    </td>
                    <td className="py-2 pr-4 text-right font-mono text-xs">{it.seat}</td>
                    <td className="py-2 pr-4 text-right text-xs">
                      {relTime(it.deadlineCommit)}
                    </td>
                    <td className="py-2 pr-4 text-right text-xs">
                      {relTime(it.deadlineReveal)}
                    </td>
                    <td className="py-2 text-right">
                      {needsCommit ? (
                        <Link
                          href={`/cases/${it.caseUuid}`}
                          className="badge bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                        >
                          commit
                        </Link>
                      ) : needsReveal ? (
                        <Link
                          href={`/cases/${it.caseUuid}`}
                          className="badge bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200"
                        >
                          reveal
                        </Link>
                      ) : (
                        <span className="text-xs text-zinc-500">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
