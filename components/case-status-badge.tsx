const palette: Record<string, string> = {
  awaiting_panel:
    "bg-purple-100 text-purple-900 dark:bg-purple-900/40 dark:text-purple-200",
  open: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  revealing:
    "bg-sky-100 text-sky-900 dark:bg-sky-900/40 dark:text-sky-200",
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
  resolved: "Resolved",
  default_resolved: "Default 50/50",
  stalled: "Stalled",
}

export function CaseStatusBadge({ status }: { status: string }) {
  const cls = palette[status] ?? palette.open
  const text = label[status] ?? status
  return <span className={`badge ${cls}`}>{text}</span>
}
