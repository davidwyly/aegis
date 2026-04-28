import { readAdminStatus } from "@/lib/admin/status"

export const dynamic = "force-dynamic"

function formatLag(seconds: number): { label: string; tone: "ok" | "warn" | "bad" } {
  if (seconds < 60) return { label: `${seconds}s`, tone: "ok" }
  if (seconds < 5 * 60) return { label: `${Math.floor(seconds / 60)}m`, tone: "ok" }
  if (seconds < 30 * 60) return { label: `${Math.floor(seconds / 60)}m`, tone: "warn" }
  if (seconds < 60 * 60)
    return { label: `${Math.floor(seconds / 60)}m`, tone: "bad" }
  return { label: `${Math.floor(seconds / 3600)}h`, tone: "bad" }
}

const toneClass: Record<"ok" | "warn" | "bad", string> = {
  ok: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  warn: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  bad: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
}

export default async function AdminPage() {
  let status: Awaited<ReturnType<typeof readAdminStatus>> | null = null
  let dbError: string | null = null
  try {
    status = await readAdminStatus()
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Keeper progress, case backlog, and roster health. Refresh this page
          after each <code className="font-mono">pnpm keeper</code> tick.
        </p>
      </div>

      {dbError && (
        <div className="card border-rose-300 bg-rose-50 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
          DB unavailable: {dbError}
        </div>
      )}

      {status && (
        <>
          <section className="card">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Indexer cursors
            </h2>
            {status.cursors.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                No keeper ticks recorded yet.
              </p>
            ) : (
              <table className="mt-2 w-full text-sm">
                <thead className="text-xs text-zinc-500">
                  <tr>
                    <th className="text-left font-normal">Chain</th>
                    <th className="text-left font-normal">Contract</th>
                    <th className="text-left font-normal">Event</th>
                    <th className="text-right font-normal">Last block</th>
                    <th className="text-right font-normal">Lag</th>
                  </tr>
                </thead>
                <tbody>
                  {status.cursors.map((c) => {
                    const lag = formatLag(c.lagSeconds)
                    return (
                      <tr
                        key={`${c.chainId}-${c.contractAddress}-${c.eventName}`}
                        className="border-t border-zinc-200 dark:border-zinc-800"
                      >
                        <td className="py-1">{c.chainId}</td>
                        <td className="font-mono text-xs">
                          {c.contractAddress.slice(0, 10)}…
                        </td>
                        <td className="font-mono text-xs">{c.eventName}</td>
                        <td className="text-right font-mono">{c.lastBlock}</td>
                        <td className="text-right">
                          <span className={`badge ${toneClass[lag.tone]}`}>
                            {lag.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Cases
            </h2>
            <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-zinc-500">In-flight</dt>
                <dd className="text-2xl font-mono">{status.inflightCases}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Stuck (past reveal)</dt>
                <dd className="text-2xl font-mono">
                  {status.stuckCases > 0 ? (
                    <span className="text-rose-700 dark:text-rose-300">
                      {status.stuckCases}
                    </span>
                  ) : (
                    status.stuckCases
                  )}
                </dd>
              </div>
              <div>
                <dt
                  className="text-xs text-zinc-500"
                  title="awaiting_panel for >1h — Chainlink VRF subscription health signal"
                >
                  VRF stuck
                </dt>
                <dd className="text-2xl font-mono">
                  {status.vrfStuckCases > 0 ? (
                    <span className="text-rose-700 dark:text-rose-300">
                      {status.vrfStuckCases}
                    </span>
                  ) : (
                    status.vrfStuckCases
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Active arbiters</dt>
                <dd className="text-2xl font-mono">{status.arbitersActive}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Failed imports</dt>
                <dd className="text-2xl font-mono">
                  {status.unresolvedFailures > 0 ? (
                    <a
                      href="/admin/failures"
                      className="text-rose-700 hover:underline dark:text-rose-300"
                    >
                      {status.unresolvedFailures}
                    </a>
                  ) : (
                    <a href="/admin/failures" className="hover:underline">
                      {status.unresolvedFailures}
                    </a>
                  )}
                </dd>
              </div>
            </dl>

            <div className="mt-4 grid grid-cols-5 gap-2 text-xs">
              {status.caseCounts.map((c) => (
                <div key={c.status} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
                  <div className="text-zinc-500">{c.status}</div>
                  <div className="font-mono text-base">{c.count}</div>
                </div>
              ))}
            </div>
          </section>

          {status.stuckCases > 0 && (
            <div className="card border-rose-300 bg-rose-50 text-sm dark:border-rose-800 dark:bg-rose-950/50">
              <div className="font-medium text-rose-900 dark:text-rose-200">
                {status.stuckCases} case{status.stuckCases === 1 ? "" : "s"} past
                reveal window
              </div>
              <p className="mt-1 text-rose-900 dark:text-rose-300">
                The keeper auto-finalizes these on each tick. If this number
                isn&apos;t shrinking, check that <code>pnpm keeper</code> is
                running and that <code>KEEPER_PRIVATE_KEY</code> has gas.
              </p>
            </div>
          )}

          {status.vrfStuckCases > 0 && (
            <div className="card border-rose-300 bg-rose-50 text-sm dark:border-rose-800 dark:bg-rose-950/50">
              <div className="font-medium text-rose-900 dark:text-rose-200">
                {status.vrfStuckCases} case
                {status.vrfStuckCases === 1 ? "" : "s"} awaiting VRF for &gt; 1
                hour
              </div>
              <p className="mt-1 text-rose-900 dark:text-rose-300">
                Healthy Chainlink VRF subscriptions fulfill in seconds. A
                non-trivial backlog at this age means the subscription is
                out of LINK or the keeper bridge isn&apos;t requesting at
                all. Check the subscription on the Chainlink VRF dashboard
                and that <code>requestRandomWords</code> is being called.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
