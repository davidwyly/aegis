// Case-status constants, types, and predicates — kept in a module
// that is safe to import from both server and client code. The
// drizzle `pgEnum` (`caseStatusEnum`) in `lib/db/schema.ts` is built
// from the same `CASE_STATUSES` tuple, so the on-disk enum and the
// in-app type stay in lockstep.
//
// This module deliberately has no `server-only` import — a UI helper
// that wants `isResolvedCaseStatus(status)` should not have to pull in
// drizzle (and its server-only guard) just to compare two strings.

export const CASE_STATUSES = [
  "awaiting_panel", // CaseRequested seen; VRF callback still pending
  "open",
  "revealing",
  // Appeals lifecycle
  "appealable_resolved", // original-panel verdict staged; appeal window open
  "appeal_awaiting_panel", // VRF requested for the appeal panel
  "appeal_open", // appeal commit phase
  "appeal_revealing", // appeal reveal phase
  // Terminal
  "resolved",
  "default_resolved",
  "stalled",
] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]

// Post-resolution states — a verdict is on file. `stalled` is also
// "terminal" in the lifecycle sense (no further progress), but it has
// NO verdict, so it is intentionally excluded from the visibility
// gates that flip brief/evidence access to the opposing party.
export const RESOLVED_CASE_STATUSES = [
  "resolved",
  "default_resolved",
] as const satisfies readonly CaseStatus[]
export type ResolvedCaseStatus = (typeof RESOLVED_CASE_STATUSES)[number]
export function isResolvedCaseStatus(s: string): s is ResolvedCaseStatus {
  return (RESOLVED_CASE_STATUSES as readonly string[]).includes(s)
}

// De novo blindness: an assigned arbiter must not be able to tell
// whether the case they're sitting on is in the original or appeal
// phase. The contract emits phase-agnostic events; the off-chain
// status enum still carries the distinction (DB migration TBD), so
// any surface that flows status to an arbiter MUST collapse the
// appeal_* values to their base equivalents first.
//
// `LeakingAppealStatus` is derived from the `CaseStatus` union via
// template-literal extraction, NOT from the map's keys, so any new
// `appeal_*` value added to the schema enum is automatically caught
// at the type level — and the `Record<LeakingAppealStatus, …>` typing
// on the map then forces a compile error here until the maintainer
// adds an explicit base-status mapping.
//
// `appealable_resolved` is intentionally NOT a leaking status — its
// prefix is `appealable_`, which the template literal does not match.
// It tells the original arbiter their verdict has been rendered,
// information they already had by virtue of having revealed.
type LeakingAppealStatus = Extract<CaseStatus, `appeal_${string}`>

// A `CaseStatus` minus the appeal_* variants — the privacy invariant
// expressed in the type system. Functions and shapes that flow to
// arbiters should use this type rather than the raw `CaseStatus`, so
// the compiler refuses to assign a leaking value in the first place.
export type ArbiterSafeCaseStatus = Exclude<CaseStatus, LeakingAppealStatus>

const APPEAL_STATUS_MAP: Record<LeakingAppealStatus, ArbiterSafeCaseStatus> = {
  appeal_awaiting_panel: "awaiting_panel",
  appeal_open: "open",
  appeal_revealing: "revealing",
}

function isLeakingAppealStatus(s: CaseStatus): s is LeakingAppealStatus {
  return s in APPEAL_STATUS_MAP
}

export function sanitizeStatusForArbiter(
  status: CaseStatus,
): ArbiterSafeCaseStatus {
  return isLeakingAppealStatus(status) ? APPEAL_STATUS_MAP[status] : status
}
