import Link from "next/link"

/**
 * Right-rail action checklist for an assigned arbiter, mirroring the
 * "What to do" panel in the locked-in mockup. Each item shows a
 * checked / unchecked state based on the arbiter's actual progress.
 *
 * The component is presentational — it doesn't read on-chain state
 * itself; the case page passes in flags derived from the panel-
 * member row and current case phase.
 */
export function ArbiterChecklist({
  hasCommitted,
  hasRevealed,
  inCommitWindow,
  inRevealWindow,
  hasEncryptionKey,
  arbiterAddress,
}: {
  hasCommitted: boolean
  hasRevealed: boolean
  inCommitWindow: boolean
  inRevealWindow: boolean
  hasEncryptionKey: boolean
  arbiterAddress: string
}) {
  const items: ChecklistItem[] = [
    {
      done: hasEncryptionKey,
      label: "Configure encryption key",
      hint: hasEncryptionKey
        ? "Active — you can decrypt party briefs."
        : "Required to read encrypted briefs.",
      action: hasEncryptionKey
        ? null
        : { href: `/arbiters/${arbiterAddress}`, label: "Set up" },
    },
    {
      done: hasCommitted,
      label: "Read briefs and evidence",
      hint: "Both parties' arguments and supporting files.",
    },
    {
      done: hasCommitted,
      label: "Commit your verdict",
      hint: hasCommitted
        ? "Recorded. Save your salt recovery file."
        : inCommitWindow
          ? "Decide on a fair percentage split, then commit."
          : "Commit window has closed.",
      urgent: inCommitWindow && !hasCommitted,
    },
    {
      done: hasRevealed,
      label: "Reveal your verdict",
      hint: hasRevealed
        ? "On-chain. Awaiting peers / finalize."
        : inRevealWindow
          ? "Replay your salt + percentage. Browser auto-fills if available."
          : "Available after the commit window closes.",
      urgent: inRevealWindow && !hasRevealed,
    },
  ]

  return (
    <div className="card">
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        What to do
      </h3>
      <ol className="mt-3 space-y-3">
        {items.map((item, idx) => (
          <li key={idx} className="flex gap-3">
            <span
              aria-hidden
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${
                item.done
                  ? "border-emerald-500 bg-emerald-500 text-white"
                  : item.urgent
                    ? "border-amber-500 bg-amber-50 text-amber-700 dark:border-amber-500 dark:bg-amber-900/40 dark:text-amber-200"
                    : "border-zinc-300 text-zinc-400 dark:border-zinc-700 dark:text-zinc-500"
              }`}
            >
              {item.done ? "✓" : idx + 1}
            </span>
            <div className="flex-1 text-sm">
              <div
                className={
                  item.done
                    ? "font-medium text-zinc-500 line-through dark:text-zinc-500"
                    : "font-medium text-zinc-900 dark:text-zinc-100"
                }
              >
                {item.label}
              </div>
              <div className="mt-0.5 text-xs text-zinc-500">{item.hint}</div>
              {item.action && (
                <Link
                  href={item.action.href}
                  className="mt-1 inline-block text-xs font-medium text-zinc-900 underline dark:text-zinc-100"
                >
                  {item.action.label} →
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-4 border-t border-zinc-200 pt-3 text-xs text-zinc-500 dark:border-zinc-800">
        Need help?{" "}
        <a
          href="https://github.com/davidwyly/aegis/issues"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          Contact support
        </a>
      </div>
    </div>
  )
}

type ChecklistItem = {
  done: boolean
  label: string
  hint: string
  urgent?: boolean
  action?: { href: string; label: string } | null
}
