import Link from "next/link"
import { notFound } from "next/navigation"
import {
  getCaseById,
  getPanel,
  getAppealPanel,
  listBriefsForViewer,
} from "@/lib/cases/service"
import { findConflictsForPanel } from "@/lib/arbiters/conflicts"
import { listBriefVersions } from "@/lib/cases/service"
import { getSession } from "@/lib/auth/session"
import { CaseStatusBadge } from "@/components/case-status-badge"
import { BriefEditor } from "@/components/brief-editor"
import { CommitRevealForm } from "@/components/commit-reveal-form"
import { EvidencePanel } from "@/components/evidence-panel"
import { CaseTimeline } from "@/components/case-timeline"
import { assembleTimeline } from "@/lib/cases/timeline"
import { AppealButton } from "@/components/appeal-button"
import { getChainData } from "@/lib/chains"
import { EncryptedBriefViewer } from "@/components/encrypted-brief-viewer"
import { getExplorerAddressUrl } from "@/lib/chains"

// Always server-render — the case state, panel, and brief visibility
// depend on the viewer's session and on-chain progress.
export const dynamic = "force-dynamic"

export default async function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const c = await getCaseById(id)
  if (!c) notFound()

  const panel = await getPanel(c.id)
  const appealPanel = await getAppealPanel(c.id)
  const conflictsByPanelist = await findConflictsForPanel(
    c.chainId,
    panel.map((p) => p.panelistAddress),
    [c.partyA, c.partyB],
  )
  const session = await getSession()
  const viewer = session.address ?? null
  const isPanelist = viewer
    ? panel.some((p) => p.panelistAddress.toLowerCase() === viewer.toLowerCase())
    : false
  const isAppealPanelist = viewer
    ? appealPanel.some(
        (p) => p.panelistAddress.toLowerCase() === viewer.toLowerCase(),
      )
    : false
  const appealPhase: "commit" | "reveal" | "closed" =
    c.status === "appeal_open"
      ? "commit"
      : c.status === "appeal_revealing"
        ? "reveal"
        : "closed"
  const isParty =
    viewer !== null &&
    (viewer.toLowerCase() === c.partyA.toLowerCase() ||
      viewer.toLowerCase() === c.partyB.toLowerCase())
  const briefs = await listBriefsForViewer(c.id, viewer)
  const isResolved = c.status === "resolved" || c.status === "default_resolved"
  // Edit history for each brief — only fetch full bodies once the case has
  // resolved publicly, otherwise just the count (so observers see "edited
  // N times" but not the prior content while the case is in flight).
  const briefHistories = await Promise.all(
    briefs.map(async (b) => ({
      briefId: b.id,
      versions: isResolved ? await listBriefVersions(b.id) : [],
      // Cheap count — same query, length 0 when not resolved.
      // For pre-resolution, fetch only the count.
    })),
  )
  const editCounts = await Promise.all(
    briefs.map(async (b) =>
      isResolved ? null : (await listBriefVersions(b.id)).length,
    ),
  )
  const timeline = await assembleTimeline(c.id, {
    includePrivate: isParty || isPanelist,
  })

  const now = Date.now()
  // awaiting_panel cases have no deadlines yet — render as `closed` for UI
  // gating (no commit/reveal form). Otherwise compute the live phase.
  const phase: "commit" | "reveal" | "closed" =
    !c.deadlineCommit || !c.deadlineReveal
      ? "closed"
      : now < new Date(c.deadlineCommit).getTime()
        ? "commit"
        : now < new Date(c.deadlineReveal).getTime()
          ? "reveal"
          : "closed"

  return (
    <div className="space-y-6">
      <div>
        <Link href="/cases" className="text-sm text-zinc-500 hover:underline">
          ← all cases
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Case</h1>
          <CaseStatusBadge status={c.status} />
          <span className="font-mono text-xs text-zinc-500">{c.caseId}</span>
        </div>
      </div>

      <section className="card">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Parties
        </h2>
        <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-zinc-500">Party A</dt>
            <dd className="font-mono">{c.partyA}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Party B</dt>
            <dd className="font-mono">{c.partyB}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Underlying escrow</dt>
            <dd>
              <a
                className="font-mono hover:underline"
                href={getExplorerAddressUrl(c.chainId, c.escrowAddress)}
                target="_blank"
                rel="noreferrer"
              >
                {c.escrowAddress}
              </a>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Disputed amount</dt>
            <dd className="font-mono">{c.amount}</dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Commit deadline</dt>
            <dd>
              {c.deadlineCommit
                ? new Date(c.deadlineCommit).toLocaleString()
                : "(awaiting VRF panel selection)"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Reveal deadline</dt>
            <dd>
              {c.deadlineReveal
                ? new Date(c.deadlineReveal).toLocaleString()
                : "(awaiting VRF panel selection)"}
            </dd>
          </div>
          {c.medianPercentage !== null && (
            <>
              <div>
                <dt className="text-xs text-zinc-500">Verdict</dt>
                <dd>
                  Party A {c.medianPercentage}% / Party B{" "}
                  {100 - c.medianPercentage}%
                </dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Final digest</dt>
                <dd className="font-mono text-xs">{c.finalDigest}</dd>
              </div>
            </>
          )}
        </dl>
      </section>

      <section className="card">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Panel
        </h2>
        <ul className="mt-2 space-y-1 text-sm">
          {panel.map((p) => {
            const conflicts = conflictsByPanelist.get(p.panelistAddress.toLowerCase()) ?? []
            return (
              <li key={p.panelistAddress} className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-zinc-500">seat {p.seat}</span>
                <Link
                  href={`/arbiters/${p.panelistAddress}`}
                  className="font-mono hover:underline"
                >
                  {p.panelistAddress}
                </Link>
                {p.committedAt && (
                  <span className="badge bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    committed
                  </span>
                )}
                {p.revealedAt && (
                  <span className="badge bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200">
                    revealed{p.partyAPercentage !== null && ` · ${p.partyAPercentage}/100`}
                  </span>
                )}
                {conflicts.length > 0 && (
                  <span
                    className="badge bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200"
                    title={
                      "Declared conflict with " +
                      conflicts
                        .map(
                          (c) =>
                            `${c.partyAddress.slice(0, 8)}…${c.partyAddress.slice(-4)}` +
                            (c.reason ? ` (${c.reason})` : ""),
                        )
                        .join(", ")
                    }
                  >
                    declared conflict
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {isParty && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Your brief
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Describe your case. Your brief is visible to the panel
            immediately, and to the opposing party only after the case
            resolves.
          </p>
          <div className="mt-3">
            <BriefEditor
              caseId={c.id}
              panelistAddresses={panel.map((p) => p.panelistAddress)}
              authorAddress={viewer ?? ""}
            />
          </div>
        </section>
      )}

      {(isParty ||
        isPanelist ||
        c.status === "resolved" ||
        c.status === "default_resolved") && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Evidence
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Visibility tracks the brief: parties see their own uploads,
            panelists see all once assigned, the opposing party sees
            everything only after the case resolves.
          </p>
          <div className="mt-3">
            <EvidencePanel
              caseId={c.id}
              canUpload={isParty}
              panelistAddresses={panel.map((p) => p.panelistAddress)}
              authorAddress={viewer ?? ""}
            />
          </div>
        </section>
      )}

      {(isPanelist || c.status === "resolved" || c.status === "default_resolved") && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Briefs
          </h2>
          {briefs.length === 0 ? (
            <p className="mt-1 text-sm text-zinc-500">No briefs submitted yet.</p>
          ) : (
            <ul className="mt-2 space-y-3">
              {briefs.map((b, i) => {
                const history = briefHistories[i]
                const editCount = isResolved
                  ? history.versions.length
                  : (editCounts[i] ?? 0)
                return (
                  <li key={b.id} className="border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
                    <div className="text-xs text-zinc-500">
                      <span className="font-mono">{b.authorAddress}</span> · {b.role}
                      {editCount > 0 && (
                        <span className="ml-2 italic text-amber-700 dark:text-amber-300">
                          edited {editCount}×
                        </span>
                      )}
                      {b.isEncrypted && (
                        <span className="ml-2 italic text-purple-700 dark:text-purple-300">
                          🔒 encrypted
                        </span>
                      )}
                    </div>
                    {b.isEncrypted ? (
                      <EncryptedBriefViewer sealed={b.sealed as any} />
                    ) : (
                      <pre className="mt-1 whitespace-pre-wrap text-sm">{b.body}</pre>
                    )}
                    {isResolved && history.versions.length > 0 && (
                      <details className="mt-2 text-xs text-zinc-500">
                        <summary className="cursor-pointer hover:underline">
                          Show {history.versions.length} prior version
                          {history.versions.length === 1 ? "" : "s"}
                        </summary>
                        <ul className="mt-1 space-y-2">
                          {history.versions.map((v) => (
                            <li
                              key={v.id}
                              className="border-l border-zinc-300 pl-2 dark:border-zinc-700"
                            >
                              <div className="text-[10px]">
                                v{v.version} ·{" "}
                                {new Date(v.snapshotAt).toLocaleString()}
                              </div>
                              <pre className="mt-1 whitespace-pre-wrap">
                                {v.body}
                              </pre>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {isPanelist && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Your vote ({phase} phase)
          </h2>
          <div className="mt-3">
            <CommitRevealForm
              aegisAddress={c.aegisAddress as `0x${string}`}
              caseId={c.caseId as `0x${string}`}
              phase={phase}
            />
          </div>
        </section>
      )}

      {appealPanel.length > 0 && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Appeal panel
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Larger second-instance panel (size {appealPanel.length}). Drawn
            via VRF excluding the original panel.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {appealPanel.map((p) => (
              <li key={p.panelistAddress} className="flex flex-wrap items-center gap-3">
                <span className="text-xs text-zinc-500">seat {p.seat}</span>
                <Link
                  href={`/arbiters/${p.panelistAddress}`}
                  className="font-mono hover:underline"
                >
                  {p.panelistAddress}
                </Link>
                {p.committedAt && (
                  <span className="badge bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                    committed
                  </span>
                )}
                {p.revealedAt && (
                  <span className="badge bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200">
                    revealed{p.partyAPercentage !== null && ` · ${p.partyAPercentage}/100`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {isAppealPanelist && (
        <section className="card border-amber-300 dark:border-amber-700">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Your appeal vote ({appealPhase} phase)
          </h2>
          <div className="mt-3">
            <CommitRevealForm
              aegisAddress={c.aegisAddress as `0x${string}`}
              caseId={c.caseId as `0x${string}`}
              phase={appealPhase}
              track="appeal"
            />
          </div>
        </section>
      )}

      {isParty && c.status === "appealable_resolved" && (() => {
        const chain = getChainData(c.chainId)
        const elcp = chain.elcp
        if (!elcp) {
          return (
            <section className="card">
              <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
                Appeal verdict
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                ELCP token address not configured for chain {c.chainId}.
              </p>
            </section>
          )
        }
        return (
          <section className="card border-amber-300 dark:border-amber-700">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Appeal verdict
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Original median: party A {c.medianPercentage ?? "?"} / 100. Verdict
              applies automatically once the appeal window closes if no party
              appeals.
            </p>
            <div className="mt-3">
              <AppealButton
                aegisAddress={c.aegisAddress as `0x${string}`}
                caseId={c.caseId as `0x${string}`}
                bondToken={elcp}
                bondAmount={BigInt("100000000000000000000") * 2n /* placeholder; see policy */}
              />
            </div>
          </section>
        )
      })()}

      <section className="card">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Timeline
        </h2>
        <p className="mt-1 text-xs text-zinc-500">
          Full chronological record. Vote details and brief / evidence
          authorship details only appear after the case resolves
          publicly.
        </p>
        <div className="mt-4">
          <CaseTimeline events={timeline} />
        </div>
      </section>
    </div>
  )
}
