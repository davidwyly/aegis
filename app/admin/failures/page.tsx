import Link from "next/link"
import { listUnresolved } from "@/lib/keeper/failures"
import { AdminFailureRow } from "@/components/admin-failure-row"

export const dynamic = "force-dynamic"

export default async function AdminFailuresPage() {
  let failures: Awaited<ReturnType<typeof listUnresolved>> = []
  let dbError: string | null = null
  try {
    failures = await listUnresolved()
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin" className="text-sm text-zinc-500 hover:underline">
          ← admin overview
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Failed imports
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Disputes the keeper has tried to bridge into Aegis but couldn&apos;t —
          most often because the panel pool is too small, the adapter
          isn&apos;t registered, or the escrow no longer reports as
          disputed. The keeper retries each tick; mark a row resolved
          manually if you&apos;ve confirmed the situation has been handled
          out-of-band.
        </p>
      </div>

      {dbError && (
        <div className="card border-rose-300 bg-rose-50 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
          DB unavailable: {dbError}
        </div>
      )}

      {!dbError && failures.length === 0 && (
        <div className="card text-sm text-zinc-600 dark:text-zinc-400">
          No unresolved failures. The keeper is current.
        </div>
      )}

      {!dbError && failures.length > 0 && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="pb-2 pr-4 text-left font-normal">Chain</th>
                <th className="pb-2 pr-4 text-left font-normal">Vaultra</th>
                <th className="pb-2 pr-4 text-left font-normal">Escrow</th>
                <th className="pb-2 pr-4 text-left font-normal">Milestone</th>
                <th className="pb-2 pr-4 text-right font-normal">Attempts</th>
                <th className="pb-2 pr-4 text-left font-normal">Last tried</th>
                <th className="pb-2 pr-4 text-left font-normal">Reason</th>
                <th className="pb-2 text-right font-normal" />
              </tr>
            </thead>
            <tbody>
              {failures.map((f) => (
                <AdminFailureRow
                  key={f.id}
                  failure={{
                    ...f,
                    firstSeen: f.firstSeen.toISOString(),
                    lastAttempted: f.lastAttempted.toISOString(),
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
