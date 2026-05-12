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
const APPEAL_STATUS_MAP = {
  appeal_awaiting_panel: "awaiting_panel",
  appeal_open: "open",
  appeal_revealing: "revealing",
} as const satisfies Partial<Record<CaseStatus, CaseStatus>>

type LeakingAppealStatus = keyof typeof APPEAL_STATUS_MAP

function isLeakingAppealStatus(s: CaseStatus): s is LeakingAppealStatus {
  return s in APPEAL_STATUS_MAP
}

export function sanitizeStatusForArbiter(status: CaseStatus): CaseStatus {
  return isLeakingAppealStatus(status) ? APPEAL_STATUS_MAP[status] : status
}
