# Aegis arbitration redesign — single arbiter + appeal-quorum-of-3

Status: **draft** — design under discussion, not yet implemented.

## Motivation

The current design seats a 3–7 arbiter panel via VRF sortition for every
case, and a *fresh, larger* panel on appeal. This has three known
incentive problems:

1. **Appeal panels are biased toward overturning.** They only earn the
   escrow fee on overturn; on upheld they split a small ELCP bond. Their
   dominant strategy is to find fault with the original verdict.
2. **Per-arbiter pay is thin.** The 5% Vaultra arbitration cut split
   across a panel of 5–7 leaves each arbiter with under 1% of the
   disputed amount.
3. **The appeal bond is doing two incompatible jobs.** It's the only
   appeal-side revenue source AND the deterrent against frivolous
   appeals. Sized for one, it underperforms at the other.

This redesign collapses the original panel to a single arbiter and
treats the appeal as *augmenting* that arbiter into a 3-quorum, with
the original verdict retained as one of the three votes.

## Core idea

- **Original**: 1 VRF-sortitioned arbiter renders a verdict.
- **Appeal**: 2 additional VRF-sortitioned arbiters join (excluding the
  original). Final verdict = median of all 3 votes.
- A single corrupt appeal arbiter cannot swing the verdict alone —
  they need their peer to agree in the same direction.

## State machine

```mermaid
stateDiagram-v2
    [*] --> AwaitingArbiter: openDispute
    AwaitingArbiter --> OriginalCommit: VRF fulfilled
    OriginalCommit --> OriginalReveal: commit window ends
    OriginalReveal --> AppealableResolved: arbiter revealed
    OriginalReveal --> Stalled: reveal window ended, no reveal
    Stalled --> AwaitingArbiter: round 0 — slash, redraw
    Stalled --> Defaulted: round 1 — apply 50/50
    AppealableResolved --> Resolved: appeal window expired
    AppealableResolved --> AwaitingAppealPanel: requestAppeal
    AwaitingAppealPanel --> AppealCommit: VRF fulfilled
    AppealCommit --> AppealReveal: commit window ends
    AppealReveal --> Resolved: median of 3 computed
    Resolved --> [*]: applyArbitration to escrow
    Defaulted --> [*]: applyArbitration to escrow
```

## Money flow

All percentages are of the disputed amount, denominated in the
escrow's fee token (e.g. USDC for Vaultra).

### Fee sources

| Source | Amount | Collected when | Visible to Aegis? |
|---|---|---|---|
| Vaultra platform fee | 2.5% | Escrow creation | No — stays at Vaultra |
| Payer dispute reserve | 2.5% | Escrow creation, activated on dispute | Yes, on `applyArbitration` |
| Payee cut | 2.5% | On dispute (deducted from payee's share) | Yes, on `applyArbitration` |
| Appeal fee | 2.5% | On `requestAppeal` (paid by appellant) | Yes, immediately |

### Pot routing

```mermaid
flowchart TD
    A[Dispute opened] --> B[5% pot reserved]
    B -->|Original arbiter reveals<br/>+ appeal window expires| C{Appeal filed?}
    C -->|No| D[No-appeal payout<br/>5% pot]
    C -->|Yes| E[Appeal fee +2.5%<br/>= 7.5% pot]
    E --> F[3 arbiters reveal<br/>median computed]
    F --> G[Appeal payout<br/>7.5% pot]

    D --> D1[Original: 5%<br/>OR 2.5% + 2.5% treasury]
    G --> G1[Original: 2.5%<br/>Appeal A: 2.5%<br/>Appeal B: 2.5%]
```

### No-appeal distribution

The 5% pot has two reasonable allocations (still **open**):

- **Option A** — `original = 2.5%`, `treasury = 2.5%`. Per-arbiter pay is
  consistent across the no-appeal and appeal paths.
- **Option B** — `original = 5%`, `treasury = 0%`. Original arbiter is
  rewarded extra for issuing a verdict that survives the appeal window.
  Lean: this option, since the appeal-window-survival case is the
  success path.

### Appeal distribution

The 7.5% pot is split equally among the 3 quorum members:

```
original = 2.5%
appeal arbiter A = 2.5%
appeal arbiter B = 2.5%
treasury = 0% (or trim a small slice from each if treasury revenue is desired)
```

The appeal fee always pays the new arbiters' work — regardless of
whether the median moves significantly from the original verdict.

### Appeal fee — consumed or refundable?

Under this design, "maintained vs overturned" is fuzzy because the
original vote is part of the median. Three options (still **open**):

- **Always consumed**: appellant always forfeits 2.5%. Simple, harsh on
  appellants who were genuinely correct.
- **Refund if median moved toward appellant by ≥ tolerance**: brings
  back a tunable `appealRefundThreshold` policy knob.
- **Proportional refund**: refund scales with how far the median moved
  toward the appellant's preferred outcome. Fairest, most complex.

Lean: **always consumed** for v1. The deterrent is the whole point of
the fee; refund logic can be added later if appellants complain.

### Slashing

- **Original arbiter is not slashed on overturn.** Their vote is
  retained as one of three; being outvoted by their peers is not
  misconduct.
- **Non-revealers (original or appeal) lose one `stakeRequirement`
  bond.** Same rule as the existing contract.
- **Peek-then-no-reveal** (appeal arbiter reads the original verdict
  via the explorer and refuses to reveal): same non-reveal slashing.
  The economic disincentive carries the integrity, not on-chain
  blinding.

## Sequence diagrams

### Happy path — no appeal

```mermaid
sequenceDiagram
    actor Party
    participant Vaultra
    participant Keeper
    participant Adapter
    participant Aegis
    participant VRF
    actor Arbiter

    Party->>Vaultra: raiseDispute()
    Keeper->>Adapter: registerCase(escrowId, milestoneIdx)
    Keeper->>Aegis: openDispute(escrow, caseId)
    Aegis->>VRF: requestRandomness
    VRF-->>Aegis: fulfillRandomWords(seed)
    Note over Aegis: draw 1 arbiter
    Arbiter->>Aegis: commitVote(caseId, hash)
    Arbiter->>Aegis: revealVote(caseId, %, salt, digest)
    Note over Aegis: state = AppealableResolved<br/>appeal window opens
    Note over Aegis: ... appeal window expires, no appeal ...
    Keeper->>Aegis: finalize(caseId)
    Aegis->>Adapter: applyArbitration(caseId, %, digest)
    Adapter->>Vaultra: resolveDispute(...)
    Vaultra-->>Adapter: pays 5% fee
    Adapter->>Aegis: forwards 5% fee
    Arbiter->>Aegis: claim(token)
```

### Happy path — appeal filed

```mermaid
sequenceDiagram
    actor Appellant
    participant Aegis
    participant VRF
    actor OrigArbiter
    actor NewArbA
    actor NewArbB
    participant Adapter

    Note over Aegis: state = AppealableResolved<br/>(original verdict live)
    Appellant->>Aegis: requestAppeal(caseId) + 2.5% fee
    Aegis->>VRF: requestRandomness
    VRF-->>Aegis: fulfillRandomWords(seed)
    Note over Aegis: draw 2 arbiters,<br/>excluding OrigArbiter
    NewArbA->>Aegis: commitVote (blind)
    NewArbB->>Aegis: commitVote (blind)
    Note over Aegis: commit window closes
    NewArbA->>Aegis: revealVote
    NewArbB->>Aegis: revealVote
    Aegis->>Aegis: median(orig, A, B)
    Aegis->>Adapter: applyArbitration(caseId, median, digest)
    Adapter-->>Aegis: forwards 5% escrow fee
    Note over Aegis: pot = 5% + 2.5% appeal fee = 7.5%<br/>each arbiter credited 2.5%
    OrigArbiter->>Aegis: claim
    NewArbA->>Aegis: claim
    NewArbB->>Aegis: claim
```

### Commit-before-peek protocol

The on-chain verdict is public the moment the original arbiter reveals.
"Blind" appeal voting is therefore enforced by the *Aegis UI* + the
non-reveal slashing penalty, not by cryptography.

```mermaid
sequenceDiagram
    actor Arbiter
    participant UI as Aegis UI
    participant Aegis as Aegis (on-chain)
    participant Chain as Block explorer

    Note over Arbiter,Chain: Arbiter is drawn for the appeal panel.
    Arbiter->>UI: open case
    UI-->>Arbiter: shows briefs + evidence<br/>(original verdict HIDDEN)
    Arbiter->>UI: submit commit hash
    UI->>Aegis: commitVote(caseId, hash)
    Aegis-->>UI: committed
    Note over UI: only NOW does the UI<br/>reveal the original verdict
    UI-->>Arbiter: shows original verdict (informational)
    Arbiter->>Aegis: revealVote(caseId, %, salt, digest)
```

**Threat model**: a determined arbiter can read `c.partyAPercentage`
directly from the contract via an explorer before committing. Defense:

1. **No incentive to peek-then-bail.** The arbiter's commit hash is
   binding. If they peek and dislike their commit, refusing to reveal
   costs them one `stakeRequirement` bond — typically more than they
   could earn by gaming a single case.
2. **Short commit window.** Set `commitWindow` short enough that a
   peek-and-recompute attack window is small.
3. **2-of-3 collusion barrier.** Even a peeking arbiter cannot swing
   the median alone; their peer must also disagree with the original
   in the same direction.

The blinding is therefore "soft" by cryptographic standards but
"hard" by economic standards. Acceptable.

## Edge cases

### E1. Original arbiter never commits

```mermaid
flowchart LR
    A[Arbiter assigned] --> B{Commit by deadline?}
    B -->|No, round 0| C[Slash bond<br/>VRF re-draw new arbiter]
    B -->|No, round 1| D[Apply 50/50 default<br/>slash second arbiter too]
```

Same two-round pattern as the existing contract's `_stallAndRedraw` —
one redraw, then default verdict. Default percentage = 50.

### E2. Original arbiter commits but never reveals

Treated identically to E1 — slash, redraw, then default. The committed
hash is meaningless without the reveal; we cannot extract their vote.

### E3. One appeal arbiter doesn't reveal

The 3-quorum becomes a 2-quorum: original vote + 1 revealed appeal
vote. Median of 2 = arithmetic mean.

```mermaid
flowchart LR
    A[Both appeal arbiters committed] --> B{Both reveal?}
    B -->|Yes| C[median 3 votes]
    B -->|One reveals| D[median 2 votes<br/>orig + revealed appeal]
    B -->|None reveal| E[fall back to original verdict]
    D --> F[Slash non-revealer<br/>distribute pot to revealers]
    E --> G[Slash both<br/>refund appellant]
```

**Pot distribution when only one appeal arbiter reveals**:
`original = 2.5%`, `revealing appeal arbiter = 2.5%`, `slashed bond +
unspent 2.5% appeal-arbiter slot = treasury or appellant refund`.

### E4. Both appeal arbiters fail to reveal

Original verdict was effectively never overturned. The verdict that
goes back to the escrow is the original.

- Both appeal arbiters lose their bonds (treasury).
- Appellant is **refunded their 2.5% appeal fee** — the system
  failed them, they shouldn't pay for unpaid work.
- Original arbiter is paid the no-appeal rate (Option A or B above).

This is the one place the appeal fee is reliably refunded regardless
of which "always consumed / refund / proportional" rule we pick for
question 2.

### E5. VRF fails to fulfill

Same as today: case stuck in `AwaitingArbiter` or
`AwaitingAppealPanel`. The `/admin` page surfaces it as "VRF stuck"
after 1 hour. Manual remediation: governance can call a re-request
function or top up the LINK subscription.

No contract changes from current behavior.

### E6. Arbiter tries to unstake mid-case

`lockedStake[arbiter]` already prevents this in the current contract.
Single-arbiter cases lock exactly one `stakeRequirement` per case.
Appeal cases lock one additional bond per new arbiter on top.

### E7. Appellant is not a party to the dispute

`requestAppeal` reverts: only `partyA` or `partyB` can call it (same
as current contract).

### E8. Original arbiter is drawn again as an appeal arbiter

VRF draw must exclude `case.originalArbiter` from the eligible set.
The 3-quorum is supposed to be `original + 2 distinct new`. Drawing
the original twice would collapse the quorum to 2 effective voters.

### E9. Double-finalize / replayed `applyArbitration`

`finalize` checks the case state machine and reverts if not in a
finalizable state (same as current). The escrow's `applyArbitration`
is idempotent on the escrow side via `liveCaseFor` mapping.

### E10. Median is a tie / non-integer

Votes are `uint16` percentages 0–100. With 3 votes, the median is
always the middle value — a single integer, no ties. With 2 votes
(E3 fallback), use floor((a+b)/2) for determinism.

### Edge case summary

| # | Scenario | Disposition |
|---|---|---|
| E1 | Original no-commit | Slash, redraw round 0; default round 1 |
| E2 | Original no-reveal | Same as E1 |
| E3 | 1/2 appeal reveal | Median of 2 (orig + reveal); slash absent |
| E4 | 0/2 appeal reveal | Original verdict applies; refund appellant; slash both |
| E5 | VRF stuck | Same as today; manual remediation |
| E6 | Mid-case unstake | Blocked by `lockedStake` (no change) |
| E7 | Non-party appeal | Reverts (no change) |
| E8 | Original re-drawn for appeal | VRF excludes original arbiter |
| E9 | Double-finalize | State guard reverts (no change) |
| E10 | Tie median | Deterministic floor((a+b)/2) for 2-vote fallback |

## Open questions still on the table

1. **No-appeal payout to original arbiter.** Option A (2.5% +
   treasury) vs Option B (full 5% to arbiter).
2. **Appeal-fee refund mechanics.** Always consumed vs threshold
   refund vs proportional refund.
