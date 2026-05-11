import type { TimelineEvent } from "@/lib/cases/timeline"

const KIND_LABELS: Record<TimelineEvent["kind"], string> = {
  case_opened: "Case opened",
  panelist_joined: "Panelist joined",
  panelist_committed: "Vote committed",
  panelist_revealed: "Vote revealed",
  panelist_left: "Panelist left",
  brief_first_submitted: "Brief submitted",
  brief_updated: "Brief updated",
  evidence_uploaded: "Evidence uploaded",
  case_resolved: "Case resolved",
}

const KIND_COLOR: Record<TimelineEvent["kind"], string> = {
  case_opened: "bg-zinc-300 dark:bg-zinc-700",
  panelist_joined: "bg-sky-400",
  panelist_committed: "bg-amber-400",
  panelist_revealed: "bg-emerald-400",
  panelist_left: "bg-rose-400",
  brief_first_submitted: "bg-zinc-400",
  brief_updated: "bg-zinc-400",
  evidence_uploaded: "bg-zinc-400",
  case_resolved: "bg-emerald-600",
}

function actorLabel(ev: TimelineEvent): string {
  if (ev.actor) return `${ev.actor.slice(0, 6)}…${ev.actor.slice(-4)}`
  // No actor — either the system itself (case_opened, case_resolved)
  // or the address was withheld for in-flight anonymity (panelist_*
  // events on the public timeline).
  return ev.kind.startsWith("panelist_") ? "(hidden)" : "system"
}

function describe(ev: TimelineEvent): string {
  switch (ev.kind) {
    case "case_opened":
      return `panel of ${ev.detail.panelSize}`
    case "panelist_joined":
      return `seat ${ev.detail.seat}`
    case "panelist_committed":
      return `seat ${ev.detail.seat}`
    case "panelist_revealed": {
      const pct = ev.detail.partyAPercentage as number | null
      return pct !== null
        ? `seat ${ev.detail.seat} · ${pct}/100`
        : `seat ${ev.detail.seat}`
    }
    case "panelist_left":
      return `seat ${ev.detail.seat} · ${ev.detail.reason}`
    case "brief_first_submitted":
    case "brief_updated":
      return `${ev.detail.role}`
    case "evidence_uploaded":
      return `${ev.detail.fileName} (${ev.detail.mimeType})`
    case "case_resolved": {
      const pct = ev.detail.medianPercentage as number | null
      const status = ev.detail.status as string
      return pct !== null
        ? `${status} · partyA ${pct}/100`
        : (status as string)
    }
  }
}

export function CaseTimeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-zinc-500">No events recorded yet.</p>
  }
  return (
    <ol className="relative ml-2 space-y-2 border-l border-zinc-200 pl-4 dark:border-zinc-800">
      {events.map((ev, i) => (
        <li key={i} className="relative">
          <span
            className={`absolute -left-[22px] top-1.5 h-2.5 w-2.5 rounded-full ${KIND_COLOR[ev.kind]}`}
          />
          <div className="text-xs text-zinc-500">
            {new Date(ev.at).toLocaleString()}
          </div>
          <div className="text-sm">
            <span className="font-medium">{KIND_LABELS[ev.kind]}</span>
            {" — "}
            <span className="font-mono text-xs">{actorLabel(ev)}</span>
            <span className="ml-2 text-zinc-600 dark:text-zinc-400">
              {describe(ev)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  )
}
