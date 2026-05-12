import Link from "next/link"
import { notFound } from "next/navigation"
import {
  getCaseById,
  getPanel,
  getAppealPanel,
  listBriefsForViewer,
} from "@/lib/cases/service"
import { findConflictsForPanel } from "@/lib/arbiters/conflicts"
import { listBriefVersionsByBriefIds } from "@/lib/cases/service"
import { getSession } from "@/lib/auth/session"
import { CaseStatusBadge } from "@/components/case-status-badge"
import { BriefEditor } from "@/components/brief-editor"
import { CommitRevealForm } from "@/components/commit-reveal-form"
import { SaltRecoveryBanner } from "@/components/salt-recovery-banner"
import { ArbiterChecklist } from "@/components/arbiter-checklist"
import { readArbiterProfile } from "@/lib/arbiters/profile"
import { EvidencePanel } from "@/components/evidence-panel"
import { CaseTimeline } from "@/components/case-timeline"
import { assembleTimeline } from "@/lib/cases/timeline"
import { DEFAULT_APPEAL_FEE_BPS, readAppealFeeBps } from "@/lib/policy"
import { AppealButton } from "@/components/appeal-button"
import { getChainData } from "@/lib/chains"
import { EncryptedBriefViewer } from "@/components/encrypted-brief-viewer"
import { BriefDownloadButton } from "@/components/brief-download-button"
import { getExplorerAddressUrl } from "@/lib/chains"

// Always server-render — the case state, panel, and brief visibility
// depend on the viewer's session and on-chain progress.
export const dynamic = "force-dynamic"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// Render the right-rail "closes in" value. For arbiters in active
// phases we surface the *current* deadline (commit or reveal); for
// everyone else the closer of the two. Also returns the underlying
// deadline timestamp so the caller can color-escalate the display
// (zinc → amber → red) per ux-design.md invariant #3.
function railCountdown(args: {
  status: string
  deadlineCommit: Date | string | null
  deadlineReveal: Date | string | null
  now: number
}): { label: string; value: string; deadlineMs: number | null } {
  const { status, deadlineCommit, deadlineReveal, now } = args
  if (status === "resolved" || status === "default_resolved") {
    return { label: "Resolved", value: "", deadlineMs: null }
  }
  if (status === "awaiting_panel" || status === "appeal_awaiting_panel") {
    return { label: "Awaiting panel", value: "", deadlineMs: null }
  }
  const commitMs = deadlineCommit ? new Date(deadlineCommit).getTime() : null
  const revealMs = deadlineReveal ? new Date(deadlineReveal).getTime() : null
  const target =
    commitMs !== null && now < commitMs
      ? commitMs
      : revealMs !== null && now < revealMs
        ? revealMs
        : null
  if (target === null) return { label: "Closed", value: "", deadlineMs: null }
  const ms = target - now
  const totalMin = Math.floor(ms / 60_000)
  const days = Math.floor(totalMin / (60 * 24))
  const hours = Math.floor((totalMin - days * 60 * 24) / 60)
  const mins = totalMin - days * 60 * 24 - hours * 60
  let value: string
  if (days > 0) value = `${days}d ${hours}h`
  else if (hours > 0) value = `${hours}h ${mins}m`
  else value = `${mins}m`
  return { label: "Closes in", value, deadlineMs: target }
}

// Zinc → amber → red escalation as the deadline approaches, per
// ux-design.md "Deadline urgency" invariant. Thresholds are absolute
// (1h / 6h) rather than relative to the phase window — keeps the rule
// readable and matches a user's wall-clock intuition.
function countdownColor(deadlineMs: number | null, nowMs: number): string {
  if (deadlineMs === null) return "text-zinc-900 dark:text-zinc-100"
  const remaining = deadlineMs - nowMs
  if (remaining < 60 * 60_000) return "text-rose-600 dark:text-rose-400"
  if (remaining < 6 * 60 * 60_000) return "text-amber-600 dark:text-amber-400"
  return "text-zinc-900 dark:text-zinc-100"
}

// Human label + color band for the YOUR STATUS card. Sanitizes
// appeal_* states to their original equivalents for assigned arbiters
// per de novo blindness — they should not know which phase they're
// arbitrating.
function phaseFor(args: {
  status: string
  isAssignedArbiter: boolean
}): { text: string; band: string } {
  const { status, isAssignedArbiter } = args
  const effective = isAssignedArbiter
    ? status === "appeal_awaiting_panel"
      ? "awaiting_panel"
      : status === "appeal_open"
        ? "open"
        : status === "appeal_revealing"
          ? "revealing"
          : status
    : status
  switch (effective) {
    case "awaiting_panel":
      return {
        text: "Awaiting panel",
        band: "bg-purple-100 text-purple-900 dark:bg-purple-900/30 dark:text-purple-200",
      }
    case "open":
      return {
        text: "Commit phase",
        band: "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200",
      }
    case "revealing":
      return {
        text: "Reveal phase",
        band: "bg-sky-100 text-sky-900 dark:bg-sky-900/30 dark:text-sky-200",
      }
    case "appealable_resolved":
      return {
        text: "Appeal window",
        band: "bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-200",
      }
    case "resolved":
      return {
        text: "Resolved",
        band: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200",
      }
    case "default_resolved":
      return {
        text: "Default 50/50",
        band: "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200",
      }
    case "stalled":
      return {
        text: "Stalled",
        band: "bg-rose-100 text-rose-900 dark:bg-rose-900/30 dark:text-rose-200",
      }
    default:
      return {
        text: effective,
        band: "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200",
      }
  }
}

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
  // The signed-in wallet is currently filling an arbiter slot on this
  // case (either original or one of the two appeal slots). Used to
  // gate de novo UI sanitization — assigned arbiters don't see panel
  // listings, appeal-context labels, or peer arbiter identities.
  const isAssignedArbiter = isPanelist || isAppealPanelist
  // Find the viewer's specific panel row (original or appeal) to know
  // their commit/reveal progress for the checklist.
  const viewerPanelRow = !viewer
    ? null
    : (panel.find((p) => p.panelistAddress.toLowerCase() === viewer.toLowerCase()) ??
        appealPanel.find((p) => p.panelistAddress.toLowerCase() === viewer.toLowerCase()) ??
        null)
  // Encryption-key status — gate the checklist's first item.
  const viewerProfile = isAssignedArbiter && viewer
    ? await readArbiterProfile(viewer)
    : null
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
  // D13 soft anonymity — public observers must not see assigned
  // arbiter identities while the case is in flight (would enable
  // bribery targeting). Parties may see them (they're stakeholders);
  // post-resolution and during the appeal window everyone can.
  const panelListingVisible =
    isParty ||
    isResolved ||
    c.status === "appealable_resolved" ||
    c.status === "appeal_awaiting_panel"
  // Edit history for each brief — one bulk query for all briefs on the
  // page (was N+1: two findMany calls per brief × N briefs). Bodies are
  // only surfaced post-resolution; pre-resolution we keep the count so
  // observers can see "edited N times" without seeing prior content.
  const versionsByBriefId = await listBriefVersionsByBriefIds(
    briefs.map((b) => b.id),
  )
  const briefHistories = briefs.map((b) => ({
    briefId: b.id,
    versions: isResolved ? (versionsByBriefId.get(b.id) ?? []) : [],
  }))
  const editCounts = briefs.map((b) =>
    isResolved ? null : (versionsByBriefId.get(b.id)?.length ?? 0),
  )
  const timeline = await assembleTimeline(c.id, {
    includePrivate: isParty || isPanelist,
  })

  // appealFeeBps governs the AppealButton fee amount. Reads on-chain
  // (falls back to DEFAULT_APPEAL_FEE_BPS if the RPC fails). Cheap on
  // hardhat, single call per render on real chains.
  const appealFeeBps =
    c.status === "appealable_resolved"
      ? await readAppealFeeBps(c.chainId, c.aegisAddress as `0x${string}`)
      : DEFAULT_APPEAL_FEE_BPS

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

  const countdown = railCountdown({
    status: c.status,
    deadlineCommit: c.deadlineCommit,
    deadlineReveal: c.deadlineReveal,
    now,
  })
  const roleLabel = isAssignedArbiter
    ? "Panelist"
    : isParty
      ? "Party"
      : "Observer"
  const phaseDisplay = phaseFor({
    status: c.status,
    isAssignedArbiter,
  })

  return (
    <div className="space-y-6">
      <div>
        <Link href="/cases" className="text-sm text-zinc-500 hover:underline">
          ← all cases
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isAssignedArbiter ? "Case at arbitration" : "Case"}
          </h1>
          <CaseStatusBadge status={c.status} forArbiter={isAssignedArbiter} />
          <span className="font-mono text-xs text-zinc-500">{c.caseId}</span>
        </div>
        {isAssignedArbiter && (
          <p className="mt-3 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
            You have been randomly selected to arbitrate this case. Your
            identity is hidden — the parties and the DAO cannot see you. Read
            the briefs and evidence carefully, then commit your verdict before
            the deadline.
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <main className="space-y-6">

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
          <div className="sm:col-span-2">
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
        </dl>
      </section>

      {/* Panel listing is gated by two rules:
            1. Assigned arbiters never see it (de novo — no peer
               identities, no phase context).
            2. Public observers don't see it during flight either
               (D13 anonymity — protects panel from bribery
               targeting before they reveal).
          Parties see it throughout; everyone sees it post-resolution. */}
      {!isAssignedArbiter && panelListingVisible && (
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
      )}

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
                const title =
                  b.role === "partyA" ? "Claimant Brief" : "Respondent Brief"
                const byteSize = b.isEncrypted
                  ? null
                  : Buffer.byteLength(b.body ?? "", "utf8")
                return (
                  <li key={b.id} className="border-l-2 border-zinc-200 pl-3 dark:border-zinc-800">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">{title}</p>
                        <p className="text-xs text-zinc-500">
                          Submitted by{" "}
                          <span className="font-mono">{b.authorAddress}</span>
                          {" · "}
                          {new Date(b.submittedAt).toLocaleDateString()}
                          {byteSize !== null && (
                            <span> · {formatBytes(byteSize)}</span>
                          )}
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
                        </p>
                      </div>
                      {!b.isEncrypted && (
                        <BriefDownloadButton
                          fileName={`${b.role}-brief-${c.caseId.slice(2, 10)}.txt`}
                          body={b.body}
                        />
                      )}
                    </div>
                    {b.isEncrypted ? (
                      <EncryptedBriefViewer sealed={b.sealed as any} />
                    ) : (
                      <pre className="mt-2 whitespace-pre-wrap text-sm">{b.body}</pre>
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

      {/* Single unified "Your vote" section per de novo — same shape
          regardless of whether the arbiter is filling the original
          slot or one of the two appeal slots. The contract routes by
          msg.sender; the form looks identical to the arbiter. The
          checklist that used to sit beside this form now lives in the
          page's right rail (`What to do` card) so observers and
          parties get role-appropriate guidance too. */}
      {isAssignedArbiter && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Your vote
          </h2>
          <div className="mt-3">
            <CommitRevealForm
              aegisAddress={c.aegisAddress as `0x${string}`}
              caseId={c.caseId as `0x${string}`}
              phase={isPanelist ? phase : appealPhase}
            />
          </div>
        </section>
      )}

      {/* Appeal panel listing follows the same D13 rule as the
          original panel: hidden from assigned arbiters (de novo) and
          from public observers during flight (anonymity). */}
      {!isAssignedArbiter && panelListingVisible && appealPanel.length > 0 && (
        <section className="card">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            Appeal panel
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            Two additional arbiters drawn via VRF excluding the original.
            Final verdict is the median of all three.
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

      {isParty && c.status === "appealable_resolved" && (() => {
        // D12 — full winners cannot appeal. If the viewer's side fully
        // won (100% to partyA when viewer is partyA, or 0% to partyA
        // when viewer is partyB), suppress the appeal section entirely.
        const pct = c.medianPercentage
        const viewerIsPartyA =
          viewer !== null && viewer.toLowerCase() === c.partyA.toLowerCase()
        const viewerIsPartyB =
          viewer !== null && viewer.toLowerCase() === c.partyB.toLowerCase()
        if (pct === 100 && viewerIsPartyA) return null
        if (pct === 0 && viewerIsPartyB) return null

        // Read appeal fee from policy() on-chain so the displayed and
        // submitted amount honors any governance-tuned value. Falls back
        // to the spec-frozen default (250 bps = 2.5%, D2) if the RPC
        // read fails.
        const feeAmount =
          (BigInt(c.amount) * BigInt(appealFeeBps)) / 10000n

        return (
          <section className="card border-amber-300 dark:border-amber-700">
            <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
              Appeal verdict
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Original verdict: {pct ?? "?"}% to party A, {100 - (pct ?? 0)}% to
              party B. Verdict applies automatically once the appeal window
              closes if no party appeals.
            </p>
            <div className="mt-3">
              <AppealButton
                aegisAddress={c.aegisAddress as `0x${string}`}
                caseId={c.caseId as `0x${string}`}
                feeToken={c.feeToken as `0x${string}`}
                feeAmount={feeAmount}
                feeTokenSymbol="USDC"
                feeTokenDecimals={6}
              />
            </div>
          </section>
        )
      })()}

      {/* Timeline is hidden from assigned arbiters per de novo —
          chronological event records leak phase context (e.g.
          AppealRequested or the timestamp of the original arbiter's
          reveal). Parties and visitors see it as today. */}
      {!isAssignedArbiter && (
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
      )}

      </main>

      <aside className="space-y-4">
        <section className="card">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            {countdown.label}
          </p>
          {countdown.value && (
            <>
              <p
                className={`mt-1 font-mono text-2xl tracking-tight ${countdownColor(countdown.deadlineMs, now)}`}
              >
                {countdown.value}
              </p>
              {countdown.deadlineMs !== null && (
                <p className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  {new Date(countdown.deadlineMs).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              )}
            </>
          )}
        </section>

        <section className="card">
          <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Your status
          </p>
          <p className="mt-1 text-sm font-medium uppercase tracking-wide">
            {roleLabel}
          </p>
          <p
            className={`mt-2 rounded px-2 py-1 text-center text-[11px] font-medium uppercase tracking-wider ${phaseDisplay.band}`}
          >
            {phaseDisplay.text}
          </p>
        </section>

        <section className="card">
          <h2 className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Case details
          </h2>
          <dl className="mt-2 space-y-2 text-xs">
            <div>
              <dt className="text-zinc-500">Case ID</dt>
              <dd className="font-mono break-all">{c.caseId}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Chain</dt>
              <dd>{c.chainId}</dd>
            </div>
            {/* Round + panel size leak phase context to arbiters
                (round 0 = original; round 1 = appeal). Hide them from
                assigned arbiters; parties + visitors see them. */}
            {!isAssignedArbiter && (
              <>
                <div>
                  <dt className="text-zinc-500">Round</dt>
                  <dd>{c.round}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Panel size</dt>
                  <dd>{c.panelSize}</dd>
                </div>
              </>
            )}
            <div>
              <dt className="text-zinc-500">Disputed amount</dt>
              <dd className="font-mono">{c.amount}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Submitted</dt>
              <dd>{new Date(c.openedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Commit deadline</dt>
              <dd>
                {c.deadlineCommit
                  ? new Date(c.deadlineCommit).toLocaleString()
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Reveal deadline</dt>
              <dd>
                {c.deadlineReveal
                  ? new Date(c.deadlineReveal).toLocaleString()
                  : "—"}
              </dd>
            </div>
            {/* De novo — assigned arbiters must not see the original
                verdict until the case is fully resolved. Otherwise an
                appeal arbiter would be biased by the original median.
                Parties and visitors see it as soon as it's staged. */}
            {c.medianPercentage !== null &&
              (!isAssignedArbiter || isResolved) && (
                <>
                  <div>
                    <dt className="text-zinc-500">Verdict</dt>
                    <dd>
                      Party A {c.medianPercentage}% / Party B{" "}
                      {100 - c.medianPercentage}%
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Final digest</dt>
                    <dd className="font-mono break-all">{c.finalDigest}</dd>
                  </div>
                </>
              )}
          </dl>
        </section>

        <section className="card">
          <h2 className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            What to do
          </h2>
          {isAssignedArbiter ? (
            <div className="mt-2">
              <ArbiterChecklist
                hasCommitted={Boolean(viewerPanelRow?.committedAt)}
                hasRevealed={Boolean(viewerPanelRow?.revealedAt)}
                inCommitWindow={
                  (isPanelist ? phase : appealPhase) === "commit"
                }
                inRevealWindow={
                  (isPanelist ? phase : appealPhase) === "reveal"
                }
                hasEncryptionKey={Boolean(viewerProfile?.encryptionPubkey)}
                arbiterAddress={viewer ?? ""}
              />
            </div>
          ) : isParty ? (
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-zinc-600 dark:text-zinc-400">
              <li>Submit your brief and any supporting evidence.</li>
              <li>
                Both briefs become visible to the opposing party only after
                the case resolves.
              </li>
              <li>Wait for the panel to commit and reveal.</li>
            </ol>
          ) : (
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-zinc-600 dark:text-zinc-400">
              <li>Watch the timeline for new commits and reveals.</li>
              <li>
                Brief and rationale text become public when the case
                resolves.
              </li>
            </ol>
          )}
        </section>

        <section className="card">
          <h2 className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Need help?
          </h2>
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
            See{" "}
            <code className="font-mono text-[11px]">
              docs/integration-vaultra.md
            </code>{" "}
            for the protocol overview, or open an issue tagged{" "}
            <code className="font-mono text-[11px]">aegis</code>.
          </p>
        </section>
      </aside>
      </div>

      {/* Sticky red banner for arbiters who've committed but haven't
          acknowledged saving their recovery file. Self-gates on
          localStorage; renders nothing if no commit stash exists. */}
      {isAssignedArbiter && (
        <SaltRecoveryBanner
          aegisAddress={c.aegisAddress as `0x${string}`}
          caseId={c.caseId as `0x${string}`}
        />
      )}
    </div>
  )
}
