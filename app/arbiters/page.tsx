import Link from "next/link"
import { db, schema } from "@/lib/db/client"
import { getExplorerAddressUrl } from "@/lib/chains"
import { eq, inArray } from "drizzle-orm"

// Roster changes as governance registers / revokes arbiters.
export const dynamic = "force-dynamic"

export default async function ArbitersPage({
  searchParams,
}: {
  searchParams: Promise<{ encrypted?: string }>
}) {
  const sp = await searchParams
  const encryptedOnly = sp.encrypted === "1"

  let rows: Array<typeof schema.arbiters.$inferSelect> = []
  let keyAddresses = new Set<string>()
  let dbError: string | null = null
  try {
    rows = await db.query.arbiters.findMany({
      where: eq(schema.arbiters.status, "active"),
      orderBy: (a, { desc }) => [desc(a.caseCount), desc(a.registeredAt)],
    })
    if (rows.length > 0) {
      const keys = await db.query.arbiterKeys.findMany({
        where: inArray(
          schema.arbiterKeys.address,
          rows.map((r) => r.address),
        ),
      })
      keyAddresses = new Set(keys.map((k) => k.address))
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  const visible = encryptedOnly
    ? rows.filter((a) => keyAddresses.has(a.address))
    : rows

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Arbiters</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Vetted panel members. Roster changes flow through Eclipse DAO
          proposals; this page mirrors the on-chain registry.
        </p>
      </div>

      <div className="flex items-center gap-3 text-xs">
        <Link
          href="/arbiters"
          className={
            !encryptedOnly
              ? "btn-primary text-xs"
              : "btn-secondary text-xs"
          }
        >
          All ({rows.length})
        </Link>
        <Link
          href="/arbiters?encrypted=1"
          className={
            encryptedOnly
              ? "btn-primary text-xs"
              : "btn-secondary text-xs"
          }
        >
          Encryption-configured ({keyAddresses.size})
        </Link>
      </div>

      {dbError && (
        <div className="card border-rose-300 bg-rose-50 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
          DB unavailable: {dbError}
        </div>
      )}

      {!dbError && visible.length === 0 && (
        <div className="card text-sm text-zinc-600 dark:text-zinc-400">
          {encryptedOnly
            ? "No arbiters have configured encryption yet."
            : "No arbiters registered yet. They're added by Eclipse DAO via the registerArbiter proposal. See the governance page."}
        </div>
      )}

      <ul className="space-y-2">
        {visible.map((a) => {
          const hasKey = keyAddresses.has(a.address)
          return (
            <li
              key={`${a.chainId}:${a.address}`}
              className="card flex items-center gap-4"
            >
              <div className="grow">
                <div className="flex items-center gap-2">
                  <Link
                    href={`/arbiters/${a.address}`}
                    className="font-mono text-sm hover:underline"
                  >
                    {a.address}
                  </Link>
                  {hasKey && (
                    <span
                      className="badge bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200"
                      title="Has registered an X25519 encryption pubkey — can receive encrypted briefs"
                    >
                      🔒 encryption
                    </span>
                  )}
                </div>
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
          )
        })}
      </ul>
    </div>
  )
}
