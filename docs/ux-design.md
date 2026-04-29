# Aegis — UX design spec

A design brief for the frontend. Aegis is an Eclipse-DAO-administered
arbitration court that resolves escrow disputes via VRF-sortitioned
arbiters. This document covers screens, flows, design language, and
cross-cutting UX invariants — particularly the **de novo blindness**
property that constrains what arbiters can see.

Status: **draft** — coupled to the arbitration redesign in
`docs/arbitration-redesign.md`. The new design replaces panels of
3–7 arbiters with a single original arbiter + 2-arbiter appeal
augmentation; the UI must reflect this shift.

## Design language

Aegis is a **court**, not a marketing site. The vibe is text-dense,
utilitarian, and monochrome — closer to GitHub Issues or a docket
viewer than a consumer dapp. The user is here to do administrative
work (file briefs, cast votes, review verdicts), not to be delighted
by motion design.

### Palette

- **Base**: zinc 50 / 950 (light / dark). System color-scheme aware.
- **Borders**: zinc 200 / 800. Subtle, never busy.
- **Surfaces**: white / zinc 950. Cards float on the base.
- **Text**: zinc 900 / 100 primary, zinc 500/400 muted, zinc 400/500
  even more muted (for hints, timestamps, asides).
- **Accent (action)**: zinc 900 / 100 inverted — the primary button
  is high-contrast, not colored. The system uses no brand color.
- **State colors** (used sparingly in badges and admin):
  - amber for warnings / "needs attention"
  - red for errors / overdue / slashed
  - emerald for resolved / paid
  - sky for in-progress / awaiting

The point of avoiding a brand color is that this is **infrastructure**.
A neutral palette signals seriousness; bright colors would feel
out of place in a courtroom context.

### Typography

- Single sans-serif throughout (system stack).
- `font-feature-settings: "ss01" on, "cv11" on` already configured —
  enables ligature + alt forms for cleaner numerals.
- Code / addresses / case IDs in `font-mono text-xs`. Always.
- Headlines: `text-3xl font-semibold tracking-tight` for h1,
  `font-medium` for h2.
- Body: 14-15px (`text-sm` and `text-base`). Long-form briefs at
  `text-base leading-7` so they're readable.

### Density and rhythm

- Maximum content width: `max-w-5xl` centered. Wider feels web-y.
- Section spacing: `space-y-8` between top-level sections,
  `space-y-4` within.
- Cards: `p-4`, rounded-lg, subtle shadow, 1px border. No drop
  shadows beyond the existing `shadow-sm`.
- Tables (cases ledger, arbiters list): zebra striping is fine but
  not required; row borders work.

### Component primitives (already in `styles/globals.css`)

- `.card` — bordered surface with shadow-sm.
- `.btn-primary` — high-contrast filled button.
- `.btn-secondary` — bordered, surface-colored button.
- `.input` — bordered text input, mono font for hashes.
- `.badge` — pill, used for case status, arbiter status.

Designer should treat these as the seed; expand the kit only when
truly needed (don't introduce a fifth button variant unless you can
explain the semantic difference).
