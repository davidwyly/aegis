import { isResolvedCaseStatus } from "@/lib/cases/status"

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// Render the right-rail "closes in" value. For arbiters in active
// phases we surface the *current* deadline (commit or reveal); for
// everyone else the closer of the two. Also returns the underlying
// deadline timestamp so the caller can color-escalate the display
// (zinc → amber → red) per ux-design.md invariant #3.
export function railCountdown(args: {
  status: string
  deadlineCommit: Date | string | null
  deadlineReveal: Date | string | null
  now: number
}): { label: string; value: string; deadlineMs: number | null } {
  const { status, deadlineCommit, deadlineReveal, now } = args
  if (isResolvedCaseStatus(status)) {
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
export function countdownColor(
  deadlineMs: number | null,
  nowMs: number,
): string {
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
export function phaseFor(args: {
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
