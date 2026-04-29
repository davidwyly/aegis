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

## Information architecture

```mermaid
flowchart TD
    Home[/"Home (/)"/]
    Cases[/"Cases ledger (/cases)"/]
    CaseView[/"Case workspace (/cases/[id])"/]
    Queue[/"My queue (/queue)"/]
    Arbiters[/"Arbiters roster (/arbiters)"/]
    ArbiterProfile[/"Arbiter profile (/arbiters/[address])"/]
    Governance[/"Governance (/governance)"/]
    Admin[/"Ops dashboard (/admin)"/]
    Failures[/"Keeper failures (/admin/failures)"/]

    Home --> Cases
    Home --> Arbiters
    Home --> Governance
    Cases --> CaseView
    Queue --> CaseView
    Arbiters --> ArbiterProfile
    Admin --> Failures
```

### Auth-gated routes

- **Public** (no wallet required): Home, Cases ledger, Arbiters
  roster, Governance proposal builder (read), Case workspace
  (party identities + briefs visible only post-resolution).
- **SIWE-required**: My queue, Case workspace party-side actions
  (file brief, request appeal), arbiter actions (commit, reveal,
  recuse), arbiter profile encryption setup.
- **Role-gated within auth**: Arbiter actions only render when the
  signed-in wallet is on the case's panel; admin pages may be
  unrestricted-read but the underlying RPC keys live elsewhere.

### Top nav

A single bar across the top with: wordmark · Cases · My queue ·
Arbiters · Governance · Ops (muted) · SIWE sign-in button on the
right. Already implemented; designer should treat it as canonical
and not invent additional global nav.

## User roles and contexts

Aegis has more user types than a typical dapp. The same wallet may
be in multiple roles across different cases. **Each screen needs to
render correctly for whichever role the viewer currently holds for
the resource they're looking at.**

### Visitor (no wallet, or signed-out)

- Reads the public ledger of cases.
- Sees post-resolution data (verdict, parties, fee distribution).
- **Cannot see** arbiter identities for in-flight cases (D13
  anonymity), in-flight briefs, or commit hashes that haven't been
  revealed.

### Party (plaintiff / defendant)

A party is one of `partyA` or `partyB` on a specific case. They've
already gone through Vaultra's escrow setup (or another integrated
escrow) and are now in dispute.

- Files briefs (encrypted off-chain to arbiters).
- Watches the case progress through states.
- Decides whether to appeal (D12 gate: only if they didn't fully win).
- Claims any verdict-weighted rebate (D1(c)).

A party knows full context of their own case. Their UI shows
everything: state, deadlines, original verdict (after reveal),
appeal status, etc.

### Arbiter

An arbiter is a registered, ELCP-staked wallet. They may be drawn
for a case via VRF (1 arbiter for original, or 1 of 2 for appeal).

**Critical UX requirement (de novo)**: an arbiter's UI must NOT
distinguish between original and appeal cases when they're drawn.
They see "a case to arbitrate" — same shape, same fields, same
flow. They commit + reveal a vote. They never see whether a prior
verdict exists for this case, who other arbiters are, or that
they're contributing to a median rather than rendering solo. See
the "Critical UX invariants" section below for the enforcement
checklist.

When an arbiter is NOT acting as an arbiter — e.g., they're
viewing the public ledger or their own profile — they see normal
public information.

### Governance member (DAO)

A member of the Eclipse DAO's multisig. They use the governance
calldata builder to compose policy / roster proposals that go to
the DAO timelock.

This is a power-user flow. Visual design can be denser and more
technical than the party / arbiter views.

### Admin / operator

Whoever runs the keeper / monitors the system. Reads the ops
dashboard for keeper liveness, VRF stuck cases, indexer cursor
lag, and the failure log. Read-only UI; remediation happens
out-of-band (top up VRF subscription, restart keeper, etc.).

### Same-wallet, multi-role example

Wallet `0xAlice` could simultaneously be:
- A party in case #42 (her dispute with Bob)
- An arbiter for case #71 (a different dispute she was drawn into)
- A DAO multisig signer (when wearing her governance hat)

The UI must contextualize correctly: when Alice opens case #71's
workspace, she sees the arbiter UX (de novo sanitized). When she
opens case #42's workspace, she sees the party UX. The route is
the same; the rendering branches on role detection.
