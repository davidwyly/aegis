import Link from "next/link"
import { notFound } from "next/navigation"
import { readArbiterProfile } from "@/lib/arbiters/profile"
import { CaseStatusBadge } from "@/components/case-status-badge"
import { ConfigureEncryption } from "@/components/configure-encryption"
import { StakeForm } from "@/components/stake-form"
import { ClaimButton } from "@/components/claim-button"
import { getChainData, getExplorerAddressUrl } from "@/lib/chains"
import {
  readLockedStake,
  readClaimable,
  readTokenMetadata,
} from "@/lib/arbiters/onchain"
import { getSession } from "@/lib/auth/session"
import { db, schema } from "@/lib/db/client"
import { and, eq, inArray } from "drizzle-orm"

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

  // Self-profile sections — only when the signed-in wallet matches.
  // Fetches on-chain locked-stake per chain + claimable per (chain,
  // fee-token) the arbiter has cases for. Skipped entirely for
  // not-signed-in / not-self viewers (saves chain RPCs).
  const session = await getSession()
  const isSelf =
    session.address !== undefined &&
    session.address.toLowerCase() === address.toLowerCase()

  type StakeRow = {
    chainId: number
    aegisAddress: `0x${string}`
    elcpAddress: `0x${string}` | null
    stakedAmount: bigint
    lockedStake: bigint
  }
  type ClaimRow = {
    chainId: number
    aegisAddress: `0x${string}`
    feeToken: `0x${string}`
    amount: bigint
    tokenSymbol: string
    tokenDecimals: number
  }
  let stakeRows: StakeRow[] = []
  let claimRows: ClaimRow[] = []

  if (isSelf) {
    // Stake rows: one per chain the arbiter is on the roster. Need the
    // Aegis address (env-configured per chain) to read lockedStake.
    const stakeQueries = profile.rosterByChain.map(async (r) => {
      const cd = getChainData(r.chainId)
      const aegisAddress = cd.aegis
      if (!aegisAddress) return null
      const locked = await readLockedStake(
        r.chainId,
        aegisAddress,
        address as `0x${string}`,
      )
      return {
        chainId: r.chainId,
        aegisAddress,
        elcpAddress: cd.elcp ?? null,
        stakedAmount: BigInt(r.stakedAmount),
        lockedStake: locked,
      } satisfies StakeRow
    })
    stakeRows = (await Promise.all(stakeQueries)).filter(
      (x): x is StakeRow => x !== null,
    )

    // Claim rows: one per unique (chain, feeToken) the arbiter has
    // worked with. Sourced from cases the arbiter is on the panel for.
    const panelMembersForUser = await db.query.panelMembers.findMany({
      where: eq(schema.panelMembers.panelistAddress, address.toLowerCase()),
      columns: { caseUuid: true },
    })
    const caseUuids = panelMembersForUser.map((p) => p.caseUuid)
    const tokenPairs = new Map<string, { chainId: number; feeToken: string }>()
    if (caseUuids.length > 0) {
      const caseRows = await db.query.cases.findMany({
        where: inArray(schema.cases.id, caseUuids),
        columns: { chainId: true, feeToken: true },
      })
      for (const c of caseRows) {
        const key = `${c.chainId}:${c.feeToken.toLowerCase()}`
        tokenPairs.set(key, { chainId: c.chainId, feeToken: c.feeToken })
      }
    }
    const claimQueries = Array.from(tokenPairs.values()).map(async (p) => {
      const aegisAddress = getChainData(p.chainId).aegis
      if (!aegisAddress) return null
      const tokenAddress = p.feeToken as `0x${string}`
      const [amount, tokenMeta] = await Promise.all([
        readClaimable(
          p.chainId,
          aegisAddress,
          address as `0x${string}`,
          tokenAddress,
        ),
        readTokenMetadata(p.chainId, tokenAddress),
      ])
      return {
        chainId: p.chainId,
        aegisAddress,
        feeToken: tokenAddress,
        amount,
        tokenSymbol: tokenMeta?.symbol ?? tokenAddress.slice(0, 10),
        tokenDecimals: tokenMeta?.decimals ?? 18,
      } satisfies ClaimRow
    })
    claimRows = (await Promise.all(claimQueries)).filter(
      (x): x is ClaimRow => x !== null,
    )
    // Don't surface zero-balance claim rows — those just clutter the UI.
    claimRows = claimRows.filter((r) => r.amount > 0n)
    // Suppress drizzle unused-import warnings when no queries are issued.
    void and
  }

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

      {isSelf && stakeRows.length > 0 && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Stake management
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Stake ELCP to be eligible for panel draws. Locked stake is
            bonded to active cases and can&apos;t be withdrawn until
            those resolve.
          </p>
          <div className="mt-4 space-y-6">
            {stakeRows.map((s) => (
              <div
                key={s.chainId}
                className="border-t border-zinc-200 pt-4 first:border-0 first:pt-0 dark:border-zinc-800"
              >
                <div className="mb-2 text-xs text-zinc-500">
                  Chain{" "}
                  <a
                    href={getExplorerAddressUrl(s.chainId, s.aegisAddress)}
                    className="hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.chainId}
                  </a>
                </div>
                {s.elcpAddress ? (
                  <StakeForm
                    chainId={s.chainId}
                    aegisAddress={s.aegisAddress}
                    elcpAddress={s.elcpAddress}
                    stakedAmount={s.stakedAmount}
                    lockedStake={s.lockedStake}
                  />
                ) : (
                  <p className="text-xs text-rose-700 dark:text-rose-300">
                    ELCP address not configured for this chain. Set
                    NEXT_PUBLIC_ELCP_* in env to enable stake actions.
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {isSelf && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Pending claims
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Arbiter fees the contract is holding for you, denominated in
            each escrow&apos;s fee token. Claim pulls the full balance for
            that token.
          </p>
          {claimRows.length === 0 ? (
            <p className="mt-3 text-xs text-zinc-500">
              No claimable balances right now.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {claimRows.map((r) => (
                <li
                  key={`${r.chainId}:${r.feeToken}`}
                  className="flex flex-wrap items-center gap-3 text-xs"
                >
                  <span className="text-zinc-500">chain {r.chainId}</span>
                  <a
                    href={getExplorerAddressUrl(r.chainId, r.feeToken)}
                    className="font-mono hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.feeToken}
                  </a>
                  <ClaimButton
                    chainId={r.chainId}
                    aegisAddress={r.aegisAddress}
                    token={r.feeToken}
                    amount={r.amount}
                    tokenSymbol={r.tokenSymbol}
                    tokenDecimals={r.tokenDecimals}
                  />
                </li>
              ))}
            </ul>
          )}
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

      <section className="card">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Encryption
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Public X25519 key. Lets parties seal encrypted briefs to this
          arbiter. The signed registration message proves the wallet
          owner derived the key.
        </p>
        <div className="mt-2">
          <ConfigureEncryption ownerAddress={address} />
        </div>
      </section>

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
