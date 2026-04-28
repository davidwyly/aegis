import Link from "next/link"
import { notFound } from "next/navigation"
import { readArbiterProfile } from "@/lib/arbiters/profile"
import { CaseStatusBadge } from "@/components/case-status-badge"
import { getExplorerAddressUrl } from "@/lib/chains"

export const dynamic = "force-dynamic"

function shortDate(d: Date | null) {
  if (!d) return "—"
  return new Date(d).toLocaleString()
}

function isHexAddress(s: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(s)
}

export default async function ArbiterProfilePage({
  params,
}: {
  params: Promise<{ address: string }>
}) {
  const { address } = await params
  if (!isHexAddress(address)) notFound()

  let profile: Awaited<ReturnType<typeof readArbiterProfile>> | null = null
  let dbError: string | null = null
  try {
    profile = await readArbiterProfile(address)
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }

  if (dbError) {
    return (
      <div className="card border-rose-300 bg-rose-50 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
        DB unavailable: {dbError}
      </div>
    )
  }
  if (!profile) notFound()

  const noPresence =
    profile.rosterByChain.length === 0 && profile.cases.length === 0

  return (
    <div className="space-y-6">
      <div>
        <Link href="/arbiters" className="text-sm text-zinc-500 hover:underline">
          ← all arbiters
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Arbiter</h1>
          <span className="font-mono text-sm">{address}</span>
        </div>
      </div>

      {noPresence && (
        <div className="card text-sm text-zinc-600 dark:text-zinc-400">
          No registry rows or panel assignments found for this address.
        </div>
      )}

      {profile.rosterByChain.length > 0 && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Registry
          </h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="text-left font-normal">Chain</th>
                <th className="text-left font-normal">Status</th>
                <th className="text-right font-normal">Stake</th>
                <th className="text-right font-normal">Cases</th>
                <th className="text-left font-normal">Credential</th>
                <th className="text-left font-normal">Registered</th>
              </tr>
            </thead>
            <tbody>
              {profile.rosterByChain.map((r) => (
                <tr
                  key={r.chainId}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="py-1">
                    <a
                      href={getExplorerAddressUrl(r.chainId, address)}
                      className="hover:underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.chainId}
                    </a>
                  </td>
                  <td>
                    <span
                      className={
                        r.status === "active"
                          ? "badge bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
                          : "badge bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200"
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="text-right font-mono">{r.stakedAmount}</td>
                  <td className="text-right font-mono">{r.caseCount}</td>
                  <td className="font-mono text-xs">{r.credentialCID ?? "—"}</td>
                  <td className="text-xs">{shortDate(r.registeredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {profile.totalsByChain.length > 0 && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Resolved-case stats
          </h2>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="text-left font-normal">Chain</th>
                <th className="text-right font-normal">Panels (resolved)</th>
                <th className="text-right font-normal">Clean reveals</th>
                <th className="text-right font-normal">Non-reveals</th>
                <th className="text-right font-normal">Reveal rate</th>
              </tr>
            </thead>
            <tbody>
              {profile.totalsByChain.map((t) => {
                const rate =
                  t.casesOnPanel === 0
                    ? "—"
                    : `${Math.round((t.cleanReveals / t.casesOnPanel) * 100)}%`
                return (
                  <tr
                    key={t.chainId}
                    className="border-t border-zinc-200 dark:border-zinc-800"
                  >
                    <td className="py-1">{t.chainId}</td>
                    <td className="text-right font-mono">{t.casesOnPanel}</td>
                    <td className="text-right font-mono">{t.cleanReveals}</td>
                    <td className="text-right font-mono">{t.nonReveals}</td>
                    <td className="text-right">{rate}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}

      {profile.declaredConflicts.length > 0 && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Declared conflicts
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Addresses this arbiter has publicly declared they should not
            arbitrate. Surfaced as warnings on per-case pages when this
            arbiter is drawn for a case involving any of them.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {profile.declaredConflicts.map((c) => (
              <li
                key={`${c.chainId}-${c.partyAddress}`}
                className="flex flex-wrap items-center gap-3"
              >
                <span className="text-xs text-zinc-500">chain {c.chainId}</span>
                <span className="font-mono">{c.partyAddress}</span>
                {c.reason && (
                  <span className="text-xs text-zinc-500">{c.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {profile.cases.length > 0 && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Cases
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Vote details are hidden until each case resolves.
          </p>
          <table className="mt-2 w-full text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="text-left font-normal">Status</th>
                <th className="text-left font-normal">Case</th>
                <th className="text-right font-normal">Seat</th>
                <th className="text-right font-normal">Vote</th>
                <th className="text-right font-normal">Median</th>
                <th className="text-right font-normal">Revealed</th>
              </tr>
            </thead>
            <tbody>
              {profile.cases.map((c) => (
                <tr
                  key={`${c.caseUuid}-${c.seat}-${c.leftAt?.getTime() ?? "active"}`}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="py-1">
                    <CaseStatusBadge status={c.status} />
                    {c.leftReason && (
                      <span className="ml-2 badge bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
                        {c.leftReason}
                      </span>
                    )}
                  </td>
                  <td>
                    <Link
                      href={`/cases/${c.caseUuid}`}
                      className="font-mono text-xs hover:underline"
                    >
                      {c.caseId.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="text-right font-mono">{c.seat}</td>
                  <td className="text-right font-mono">
                    {c.leftAt
                      ? "—"
                      : c.partyAPercentage !== null
                        ? `${c.partyAPercentage}/100`
                        : c.caseResolved
                          ? "no reveal"
                          : "(in flight)"}
                  </td>
                  <td className="text-right font-mono">
                    {c.medianPercentage !== null
                      ? `${c.medianPercentage}/100`
                      : "—"}
                  </td>
                  <td className="text-right text-xs">
                    {c.revealedAt ? shortDate(c.revealedAt) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
