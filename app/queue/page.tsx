import Link from "next/link"
import { listQueueFor } from "@/lib/arbiters/queue"
import { getSession } from "@/lib/auth/session"
import { CaseStatusBadge } from "@/components/case-status-badge"
import { readArbiterProfile } from "@/lib/arbiters/profile"

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
  let encryptionConfigured = false
  try {
    items = await listQueueFor(session.address)
    const profile = await readArbiterProfile(session.address)
    encryptionConfigured = profile.encryptionPubkey !== null
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My queue</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Cases where you&apos;re the assigned arbiter. Recused or
          redrawn assignments are not shown.
        </p>
      </div>

      {/* UX invariant #4 — an arbiter without an encryption key cannot
          decrypt encrypted briefs and will blind-vote. Surface as an
          unmissable amber banner until they configure one. */}
      {!dbError && !encryptionConfigured && (
        <div className="card border-amber-300 bg-amber-50 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">
            You haven&apos;t set up your encryption key.
          </p>
          <p className="mt-1 text-xs">
            Without a key you won&apos;t be able to read encrypted briefs
            on cases you&apos;re drawn for — and blind-voting risks a slash.
          </p>
          <Link
            href={`/arbiters/${session.address}`}
            className="mt-2 inline-block text-xs font-medium underline hover:no-underline"
          >
            Configure encryption →
          </Link>
        </div>
      )}

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
              {/* No Phase column per de novo enforcement
                  (ux-design.md "queue rows are intentionally
                  undifferentiated. No Original / Appeal labels"). */}
              <tr>
                <th className="pb-2 pr-4 text-left font-normal">Status</th>
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
                      <CaseStatusBadge status={it.status} forArbiter />
                    </td>
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
