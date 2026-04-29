const palette: Record<string, string> = {
  awaiting_panel:
    "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200",
  open: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  revealing:
    "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
  appealable_resolved:
    "bg-orange-100 text-orange-900 dark:bg-orange-900/40 dark:text-orange-200",
  appeal_awaiting_panel:
    "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200",
  appeal_open:
    "bg-orange-200 text-orange-900 dark:bg-orange-900/50 dark:text-orange-200",
  appeal_revealing:
    "bg-orange-200 text-orange-900 dark:bg-orange-900/50 dark:text-orange-200",
  resolved:
    "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200",
  default_resolved:
    "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-200",
  stalled:
    "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-200",
}

const label: Record<string, string> = {
  awaiting_panel: "Awaiting VRF",
  open: "Open · commits",
  revealing: "Revealing",
  appealable_resolved: "Appeal window",
  appeal_awaiting_panel: "Appeal · awaiting VRF",
  appeal_open: "Appeal · commits",
  appeal_revealing: "Appeal · revealing",
  resolved: "Resolved",
  default_resolved: "Default 50/50",
  stalled: "Stalled",
}

/**
 * Sanitized label/palette mapping for arbiter-facing renders. Per
 * de novo, an assigned arbiter must not see whether a case is in
 * its original or appeal phase. Appeal-distinct states are
 * collapsed onto their original-phase equivalents:
 *
 *   appeal_awaiting_panel → awaiting_panel
 *   appeal_open           → open
 *   appeal_revealing      → revealing
 *
 * Other states (appealable_resolved, resolved, default_resolved,
 * stalled) are shown as-is — they're either out of the arbiter's
 * concern (case already settled) or party-facing.
 */
const sanitizeForArbiter: Record<string, string> = {
  appeal_awaiting_panel: "awaiting_panel",
  appeal_open: "open",
  appeal_revealing: "revealing",
}

export function CaseStatusBadge({
  status,
  forArbiter = false,
}: {
  status: string
  /** Render a phase-collapsed version safe for assigned arbiters. */
  forArbiter?: boolean
}) {
  const effective = forArbiter ? (sanitizeForArbiter[status] ?? status) : status
  const cls = palette[effective] ?? palette.open
  const text = label[effective] ?? effective
  return <span className={`badge ${cls}`}>{text}</span>
}
