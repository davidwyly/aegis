import Link from "next/link"
import { db, schema } from "@/lib/db/client"
import { getExplorerAddressUrl } from "@/lib/chains"
import { eq } from "drizzle-orm"

// Roster changes as governance registers / revokes arbiters.
export const dynamic = "force-dynamic"

export default async function ArbitersPage() {
  let rows: Array<typeof schema.arbiters.$inferSelect> = []
  let dbError: string | null = null
  try {
    rows = await db.query.arbiters.findMany({
      where: eq(schema.arbiters.status, "active"),
      orderBy: (a, { desc }) => [desc(a.caseCount), desc(a.registeredAt)],
    })
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Arbiters</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Vetted panel members. Roster changes flow through Eclipse DAO
          proposals; this page mirrors the on-chain registry.
        </p>
      </div>

      {dbError && (
        <div className="card border-rose-300 bg-rose-50 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
          DB unavailable: {dbError}
        </div>
      )}

      {!dbError && rows.length === 0 && (
        <div className="card text-sm text-zinc-600 dark:text-zinc-400">
          No arbiters registered yet. They&apos;re added by Eclipse DAO via
          the <code className="font-mono">registerArbiter</code> proposal.
          See the governance page.
        </div>
      )}

      <ul className="space-y-2">
        {rows.map((a) => (
          <li
            key={`${a.chainId}:${a.address}`}
            className="card flex items-center gap-4"
          >
            <div className="grow">
              <Link
                href={`/arbiters/${a.address}`}
                className="font-mono text-sm hover:underline"
              >
                {a.address}
              </Link>
              {a.credentialCID && (
                <div className="font-mono text-xs text-zinc-500">
                  cid: {a.credentialCID}
                </div>
              )}
            </div>
            <div className="text-right text-xs text-zinc-500">
              <div>{a.caseCount} cases</div>
              <div>stake: {a.stakedAmount}</div>
              <a
                href={getExplorerAddressUrl(a.chainId, a.address)}
                className="hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                chain {a.chainId} ↗
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
