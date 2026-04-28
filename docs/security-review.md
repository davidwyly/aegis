# Aegis security review (v0.1)

This is a manual pre-audit review of `blockchain/contracts/Aegis.sol` and
`blockchain/contracts/adapters/VaultraAdapter.sol`. Slither was not run in
this environment; an external audit is recommended before mainnet deploy.

## Scope

- `Aegis.sol` — court contract holding ELCP stake and routing arbitration
  fees.
- `VaultraAdapter.sol` — IArbitrableEscrow shim sitting between Aegis and
  VaultraEscrow.
- `IArbitrableEscrow.sol` — interface only, no logic.

Out of scope: VaultraEscrow itself (vendored fixture), Eclipse DAO
`Governance.sol`, the ELCP token. These are trust-anchors, not part of the
Aegis attack surface.

## Trust assumptions

The contract is correct only if these hold. Document them anywhere a Vaultra-
or-Eclipse-side change might invalidate them.

1. **Eclipse DAO Governance is honest and live.** It holds
   `DEFAULT_ADMIN_ROLE` + `GOVERNANCE_ROLE`. A captured Governance can
   register sock-puppet arbiters, set `panelFeeBps = 10_000` to drain the
   treasury, or `setPolicy({stakeRequirement: 0})` to make slashing
   meaningless. Aegis assumes the multi-sig + timelock on `Governance.sol`
   is real.
2. **ELCP is a non-malicious ERC-20.** No fee-on-transfer (would mismatch
   `stake()` accounting), no rebasing, no upgradeable freeze. If ELCP ever
   blocks Aegis's address, all stakes become permanently locked.
3. **Plug-in escrows implement `IArbitrableEscrow` honestly.** Aegis trusts
   `getDisputeContext` to return real parties + a real disputed amount.
   A malicious escrow can cause Aegis to arbitrate fake cases — but only
   for arbiters who voluntarily took panel seats on that escrow's cases.
   The real harm vector is: a malicious escrow returning party addresses
   that match a registered arbiter, then never paying the fee — wasted
   panel work. The adapter mitigates this for Vaultra by verifying
   `arbiter == address(this)` and `status == Disputed` before registering.
   For new integrations, see `docs/integration-newdapps.md`.
4. **The keeper is not adversarial in dropping events**, but assume it
   IS adversarial in delaying / re-running them. The contract is
   idempotent against re-runs, and the off-chain DB is idempotent against
   re-indexing. A keeper that drops events stalls the public ledger but
   does not lose funds.

## Findings

Severity scale: CRITICAL > HIGH > MEDIUM > LOW > INFO.
"Fixed" = remediated in this branch. "Documented" = accepted with
mitigation noted. "Deferred" = parked for v2.

### Fixed in this review

| ID | Severity | Title |
|---|---|---|
| F-01 | HIGH   | Stake-dodge — `unstake()` mid-case dodged the slash |
| F-02 | LOW    | `stake()` violated CEI (effects-after-interactions) |
| F-03 | MEDIUM | First-quorum could finalize before all reveals (was D-02) |
| F-04 | INFO   | Recusal mechanism — partial fix for D-04 |
| F-05 | LOW    | Slash now forfeits the case bond, not 50% of total stake (was D-03) |
| F-06 | MEDIUM | `openDispute` deduplication — two keepers could otherwise create twin cases |
| F-07 | MEDIUM | Chainlink VRF panel selection (was D-01) |

#### F-01 — Stake-dodge — HIGH (fixed)

A panelist could call `unstake(stakedAmount)` after being assigned to a
panel and before the reveal-window expiry. When the case stalled, the
slash math `stakedAmount / 2` would compute against zero, making the
slashing primitive a no-op. Net effect: a malicious arbiter could collect
fees on cases they liked and silently dodge any case where they expected
to be the lone dissenter, with zero downside.

**Fix:** added `mapping(address => uint96) lockedStake`. On panel
assignment, `lockedStake[panelist] += stakeRequirement`; on resolve /
default-resolve / redraw, the lock is released. `unstake()` rejects with
`StakeLocked` if it would drop free stake below zero. Panel selection
also now checks `stakedAmount - lockedStake >= stakeRequirement` so an
arbiter cannot multi-book themselves beyond their actual bond.

Regression tests: `Aegis.test.ts > stake locking while on a panel`.

#### F-02 — `stake()` CEI — LOW (fixed)

`stake()` originally called `safeTransferFrom` before bumping
`stakedAmount`. Combined with `nonReentrant` and the absence of any
external-call surface from token-receipt hooks (Aegis isn't ERC777-
aware), this was not exploitable. Reordered to checks → effects →
interactions for code-hygiene; `safeTransferFrom` reverting unwinds the
state bump in the same tx.

#### F-03 — First-quorum finalize — MEDIUM (fixed; was D-02)

`finalize()` originally resolved as soon as `revealCount >= quorum`,
which meant on a 3-panel the first two reveals decided the median.
A panelist watching the mempool could choose to reveal early or
withhold based on whether their vote would shift the median in their
favor. With panelSize = 3, `revealCount = 2` → median = lower of the
two reveals, so an attacker who wanted partyA to win would race to
reveal a low percentage and call `finalize` before the third panelist
could counter.

**Fix:** `finalize()` now resolves early ONLY when ALL panelists have
revealed. If revealCount < panelSize, the function reverts with
`RevealWindowOpen` until `block.timestamp >= deadlineReveal`. After
the window closes, quorum-based resolution proceeds; sub-quorum still
falls through to the slash + redraw / default 50-50 paths after the
grace window.

Regression tests:
`Aegis.test.ts > finalize gate (no first-quorum-decides) > rejects finalize while reveal window is still open and not all revealed` and the two companion tests for the all-revealed-fast-path and the quorum-after-window-expires paths.

#### F-04 — Recusal — INFO (added; partial fix for D-04)

Panelists can now self-recuse during the commit phase via `recuse(caseId)`.
The function:
- requires the case is `Open` and within the commit window
- requires the panelist hasn't yet committed (commits are a signal of
  willingness to rule, so post-commit recusal would be a slash dodge)
- releases the recusing panelist's stake-lock for this case
- draws a single replacement panelist using the same exclusion rules
  (no parties, no current panel members)
- emits `Recused(caseId, recused, replacement, seat)`

The off-chain indexer mirrors the seat replacement into the
`panel_members` table.

This addresses the *self-recognised* COI case. It does NOT detect
COIs the panelist refuses to disclose; that remains a vetting +
public-ledger problem.

Regression tests: `Aegis.test.ts > recusal > *`.

#### F-05 — Bond-only slashing — LOW (fixed; was D-03)

`_slashNonRevealers` originally slashed `stakedAmount / 2`. Two issues:
1. A panelist who'd staked 2× the minimum lost 1× (the same as a
   minimum-staked one), so over-staking didn't get them more
   resilience — it got them a bigger absolute loss for the same
   percentage hit. Disincentivized over-staking.
2. With 50% slash, an arbiter could reveal favourably 50%+ of the time
   and still come out ahead, which means the threat of slashing didn't
   actually deter strategic non-reveal.

**Fix:** slash exactly `min(stakedAmount, stakeRequirement)` — the
case-specific bond. An arbiter loses one full bond per non-reveal.
Over-staked arbiters keep their excess; minimum-staked ones go to zero
and stop appearing in panel draws until they re-stake.

Regression tests: `Aegis.test.ts > timeout + redraw + default 50/50 > only slashes the bond, not the entire stake of an over-staked panelist`.

#### F-06 — `openDispute` dedup — MEDIUM (fixed)

Two keepers running against the same chain (or one keeper restarted
with a stale cursor) would both call `openDispute` for the same
`(escrow, escrowCaseId)` pair. Each call generates a fresh Aegis
`caseId` from `keccak256(escrow, escrowCaseId, ++_caseNonce)`, so both
succeed and the system ends up with twin cases — twin panels, twin
slashable bonds, twin fee disbursements at resolution. The
`escrow.getDisputeContext` `active` flag wouldn't help because the
underlying Vaultra escrow is still `Disputed` at that moment.

**Fix:** added `mapping(address => mapping(bytes32 => bytes32)) liveCaseFor`.
`openDispute` reverts with `CaseAlreadyLive` if a live case exists for
that pair; resolve / default-resolve paths `delete` the entry so a
future re-arbitration (on protocols that allow it — Vaultra doesn't)
can succeed.

Keeper updated to read `liveCaseFor` before calling `openDispute` so
it skips cleanly without spending gas on a doomed simulate.

Regression test: `Aegis.test.ts > openDispute > rejects duplicate openDispute for the same (escrow, escrowCaseId)`.

#### F-07 — VRF panel selection — MEDIUM (fixed; was D-01)

Panel selection originally seeded with `keccak256(block.prevrandao,
caseId, block.timestamp)`. A validator who was also a registered
arbiter could nudge `prevrandao` + `timestamp` within consensus rules
to land themselves on a panel they wanted to influence.

**Fix:** `openDispute` is now a two-phase async flow.
1. `openDispute` records the case in `AwaitingPanel` state and calls
   `IVRFCoordinator.requestRandomWords`. No panel is drawn here.
   `CaseRequested(caseId, ..., vrfRequestId)` is emitted.
2. The Chainlink VRF coordinator calls back into
   `rawFulfillRandomWords`, which checks the sender is the registered
   coordinator and dispatches to `fulfillRandomWords`. That function
   uses the verifiable random word as the Fisher-Yates seed, seats
   the panel, sets the commit/reveal deadlines, and emits
   `CaseOpened`.

The same fulfillment handles round-1 redraw after a stall: the old
panel stays in `_panels[caseId]` as the exclude list during the
fresh draw and is overwritten when the new panel lands.

The recuse path keeps the prevrandao-derived seed (acceptable: a
panelist who recuses cannot pre-target which replacement gets drawn,
and going through VRF on every recuse would make the UX terrible).

A small interface (`IVRFCoordinator` + abstract `VRFConsumer`) is
hand-rolled at the top of `Aegis.sol` so the contract doesn't depend
on `@chainlink/contracts`. Behavior matches `VRFCoordinatorV2` +
`VRFConsumerBaseV2`.

Operational gotcha: VRF requests cost LINK / gas. A pre-check at
`openDispute` (and `_stallAndRedraw`) verifies the eligible pool is
large enough before paying the request — if not, openDispute reverts
`NotEnoughArbiters`, and the redraw path falls straight through to
the 50/50 default rather than getting stuck waiting for a fulfillment
that would revert.

Tests: `MockVRFCoordinator` (Hardhat-only) records requests + drives
fulfillments deterministically. The `openAndFulfill` helper opens a
case and then triggers fulfillment so existing tests can keep their
"open then commit/reveal" shape.

Regression tests: every Aegis test that involves `openDispute` now
exercises the full async path, including the integration test with
real Vaultra.

### Documented (accepted with mitigations)

| ID | Severity | Title |
|---|---|---|
| ~~D-01~~ | ~~MEDIUM~~ | ~~Panel-selection randomness manipulable by validators~~ — fixed as F-07 |
| ~~D-02~~ | ~~MEDIUM~~ | ~~First-quorum reveals decide the median~~ — fixed as F-03 |
| ~~D-03~~ | ~~LOW~~ | ~~Slash percentage is 50% — partial dodge still profitable~~ — fixed as F-05 |
| D-04 | LOW    | Conflict-of-interest only checks address equality |
| D-05 | LOW    | DoS by very large arbiter pool |
| D-06 | INFO   | Trust assumption: integrating escrow is honest |
| D-07 | INFO   | Zero-fee cases reward arbiters with reputation only |

#### D-04 — COI only by address equality — LOW

Constructor and `openDispute` exclude addresses that match `partyA` or
`partyB`. They do not detect:
- the same human controlling multiple addresses
- a panelist with prior dealings with a party
- a panelist who is the deployer / admin of the underlying escrow

**Mitigation:** out-of-band vetting by Eclipse DAO before
`registerArbiter`. Public ledger surfaces every panelist's case history
so consistent collusion is at least noticed. Recusal mechanism deferred
to v2.

#### D-05 — DoS by huge arbiter pool — LOW

`_drawPanelExcluding` allocates `address[](listLen)` and iterates the
full registry. At ~100-200 arbiters, panel-draw gas is fine. Beyond ~500,
gas grows linearly. **Mitigation:** governance prunes inactive
arbiters via `revokeArbiter`. Production scale would benefit from a
pre-filtered "active and free" subset structure.

#### D-06 — Integrating escrow trust — INFO

Documented under Trust Assumption #3. New escrows must implement
`IArbitrableEscrow` honestly; Aegis can't enforce this on chain. The
Vaultra adapter encodes the necessary checks.

#### D-07 — Zero-fee cases — INFO

If `getDisputeContext` returns `feeAmount` of 0 from an escrow whose
`applyArbitration` doesn't actually pay, panelists earn no fees. This
is intended in some scenarios (e.g. pure-reputation arbitration); for
escrows that promise a fee, the integration test should assert it
arrives.

### Deferred to v2

| ID | Title |
|---|---|
| V-01 | Appeals / second-instance review |
| V-05 | Recusal mechanism (D-04) |
| V-06 | Per-arbiter conflict registry (D-04) |
| V-07 | Encrypted briefs |
| V-08 | Cross-chain dispute coordination |

## Reentrancy

All state-changing functions that touch tokens or move funds carry
`nonReentrant`:

- `stake`, `unstake`, `claim`, `withdrawTreasury`
- `openDispute`, `finalize`

`commitVote` and `revealVote` are not nonReentrant and don't need to be —
they only update commit / reveal state. No token movement, no balance
read.

External calls and their guards:

| Call site | External call | Guard |
|---|---|---|
| `stake` | `stakeToken.safeTransferFrom` | nonReentrant + post-CEI |
| `unstake` | `stakeToken.safeTransfer` | nonReentrant + post-CEI |
| `claim` | `IERC20.safeTransfer` | nonReentrant + claimable=0 before transfer |
| `withdrawTreasury` | `IERC20.safeTransfer` | nonReentrant + treasury debited before transfer |
| `openDispute` | `escrow.getDisputeContext` (view, but read-only-untrusted) | nonReentrant; result feeds in-memory state only |
| `_resolveByMedian` | `escrow.applyArbitration` | nonReentrant; `c.status = Resolved` set before call |
| `_resolveDefault` | `escrow.applyArbitration` | nonReentrant; `c.status = DefaultResolved` set before call |

The case-status flip happens before the external `applyArbitration` call
so a malicious escrow that tries to reenter `finalize` (or any other
nonReentrant function) hits both the reentrancy guard and the
"already finalized" guard.

## Access control

Roles:

- `DEFAULT_ADMIN_ROLE` — granted to `governance` at deploy. Standard OZ
  semantics.
- `GOVERNANCE_ROLE` — granted to `governance` at deploy. Gates
  `registerArbiter`, `revokeArbiter`, `setPolicy`, `setNewCasesPaused`,
  `withdrawTreasury`.

Everything else is permissionless or self-service:

- Any address can call `openDispute` (the escrow is the trust anchor).
- Any address can call `finalize` after deadlines elapse — anyone-can-
  poke design.
- Only registered arbiters can `stake` / `unstake` / `commitVote` /
  `revealVote` / `claim`.

There is **no `renounceOwnership` exposure** because Aegis isn't Ownable
— it's pure AccessControl. The `DEFAULT_ADMIN_ROLE` could be renounced
by Governance, which would lock out future role changes; this is a
governance hazard, not a contract bug.

## Storage layout

Aegis is non-upgradeable. No proxy storage layout concerns. Adding the
`lockedStake` mapping in F-01 was a non-breaking change (mappings have
their own slot derivation).

## Integer math

- All arithmetic is on Solidity 0.8.24 — built-in overflow checking.
- `uint96` for `stakedAmount` / `lockedStake` — caps at ~7.9 × 10²⁸.
  ELCP at 18 decimals: caps at 79 billion ELCP per arbiter. Fine.
- `uint8 panelSize` ∈ {3, 5, 7} — validated.
- `uint16 partyAPercentage` ∈ [0, 100] — validated, semantic range is
  0-100 not 0-65535.
- `uint8 round` ∈ {0, 1} — capped by the two-round design.

## Recommendations before mainnet

1. **External audit.** This review is necessary, not sufficient.
2. **Run Slither, Mythril, Echidna.** None were run in this environment.
3. **Stand up a real Chainlink VRF subscription** for any chain where
   meaningful TVL flows through Aegis. The hand-rolled interface
   matches VRFCoordinatorV2; supply the right key hash, sub id, and
   confirmations to the deploy. Without an active subscription the
   `requestRandomWords` call reverts and `openDispute` fails — so
   subscription health is now an operational dependency. Monitor
   subscription LINK balance and fulfillment latency.
4. **Roster bootstrap procedure.** Concretely document who Eclipse DAO
   registers, against what credential standard, with what stake floor.
5. **Pause-and-migrate playbook.** If a CRITICAL issue lands post-deploy:
   `setNewCasesPaused(true)`, freeze new openings, drain treasury via
   governance, deploy v2, re-point Vaultra's `eclipseDAO`.

## Test coverage of the issues above

| Concern | Test |
|---|---|
| Stake-dodge | `Aegis.test.ts > stake locking while on a panel > blocks unstake that would drop free stake below 0 (the dodge)` |
| Multi-case lock arithmetic | `Aegis.test.ts > stake locking ... > eligibility excludes arbiters whose free stake is too low` |
| Slash math + redraw | `Aegis.test.ts > timeout + redraw + default 50/50` |
| Real Vaultra round-trip | `AegisVaultraIntegration.test.ts > real Vaultra dispute → ...` |
| Adapter `NotArbiter` rejection | `AegisVaultraIntegration.test.ts > registerCase rejects an escrow whose arbiter is not the adapter` |
| Adapter `NotDisputed` rejection | `AegisVaultraIntegration.test.ts > registerCase rejects an escrow that is not Disputed` |
| Reentrancy guards | `Aegis.test.ts` constructor ensures `nonReentrant` is wired across stake/unstake/claim/finalize/openDispute |

Last updated: 2026-04-27.
