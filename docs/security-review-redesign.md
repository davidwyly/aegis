# Aegis preliminary audit (single-arbiter + appeal-of-3 redesign)

In-house pre-audit pass against the redesigned contract on
`feat/single-arbiter-appeal-quorum`. Slither / Mythril have not been
run in this environment; this is a manual review of
`blockchain/contracts/Aegis.sol` (1488 lines) and
`blockchain/contracts/adapters/VaultraAdapter.sol` (268 lines)
against the spec frozen in `docs/arbitration-redesign.md`.

**External audit is required before mainnet.** Findings here are
defense-in-depth, not a substitute.

## Scope

- **In scope**: `Aegis.sol`, `VaultraAdapter.sol`, the `IArbitrableEscrow`
  interface, the test mocks (insofar as they exercise the contract).
- **Out of scope**: `VaultraEscrow.sol` (vendored fixture), Eclipse DAO
  `Governance.sol`, the ELCP token. These are trust anchors, not part
  of the Aegis attack surface.

## Trust assumptions (carried over from the v0 review, restated)

The contract is correct only if these hold:

1. **Eclipse DAO Governance is honest and live.** Holds
   `DEFAULT_ADMIN_ROLE` + `GOVERNANCE_ROLE`. A captured Governance can
   register sock-puppet arbiters or `setPolicy` with values that drain
   the system. Aegis assumes the multi-sig + timelock on
   `Governance.sol` is real.
2. **ELCP is a non-malicious ERC-20.** No fee-on-transfer (would
   mismatch `stake()` accounting), no rebasing, no upgradeable freeze.
   If ELCP ever blocks Aegis's address, all stakes become permanently
   locked.
3. **Plug-in escrows implement `IArbitrableEscrow` honestly.** Aegis
   trusts `getDisputeContext` to return real parties + a real disputed
   amount, and trusts the escrow's `applyArbitration` to actually
   transfer the fee it claims to. A malicious escrow can cause Aegis
   to arbitrate fake cases and waste arbiter time.
4. **Chainlink VRF returns unbiased randomness.** A captured
   coordinator could deterministically pick arbiters. The
   `VRFConsumer.rawFulfillRandomWords` access guard prevents anyone
   else from injecting fake words.
5. **`block.prevrandao` is not adversarially tunable for recuse.**
   Synchronous redraws on `recuse()` use prevrandao; a block proposer
   who's also an arbiter can in principle bias their replacement
   draw. See finding M-04.

## Severity rubric

- **C** Critical — funds at risk, system halted, or trust assumption
  bypassed in a practical attack.
- **H** High — material loss / griefing / wrong verdict under
  realistic conditions.
- **M** Medium — design corner that could cause user harm or
  operational pain.
- **L** Low — code quality / minor invariant / cosmetic.
- **I** Informational — context, not a bug.

## Summary

| ID | Severity | Title |
|---|---|---|
| C-01 | — | (none found in this pass) |
| H-01 | H | Governance can lock arbiter pay by setting `perArbiterFeeBps` above pot share |
| H-02 | H | VRF-stuck cases have no on-chain remediation path |
| M-01 | M | `_settleAppeal` pays arbiters first-come-first-served; a low-fee escrow may starve slot B |
| M-02 | M | `applyArbitration` is called between balance reads; balance-delta correct but escrow can re-enter sibling functions |
| M-03 | M | `_arbiterList` iteration cost is O(N) per draw; gas budget concern past ~500 arbiters |
| M-04 | M | `recuse()` uses `block.prevrandao` for replacement draw; manipulable by block proposers |
| L-01 | L | `_releaseLock` defensive "snap to 0" can mask accounting drift |
| L-02 | L | Median-of-2 floor rounding favors lower party (D6 by design but worth user-visible note) |
| L-03 | L | `setPolicy` accepts `commitWindow` / `revealWindow` extreme values without sanity bounds |
| L-04 | L | Stalled events emit `slashedTotal` as `stakeRequirement` regardless of actual slash |
| I-01 | I | Frontrunning `openDispute` is harmless but worth documenting |
| I-02 | I | Fee-on-transfer fee tokens are correctly handled by balance-delta |
| I-03 | I | Per-case appeal fee held in escrow's fee token; if token blacklists Aegis post-deposit, refund path becomes brittle |

## H-01 — Governance can lock arbiter pay by setting `perArbiterFeeBps` above pot share

**Severity**: High (funds-at-risk for arbiters; system DoS; requires governance capture).

**Location**: `Aegis.sol:_validatePolicy` (line ~423) and `_settleAppeal` (line ~973–984), `_settleNoAppeal` (line ~1153 implicitly).

**Description**. `_validatePolicy` allows `perArbiterFeeBps` up to
`BPS_DENOMINATOR` (10000 = 100% of disputed amount). In
`_settleAppeal` the per-arbiter share is computed as
`(c.amount * perArbiterFeeBps) / 10000`; if that exceeds the pot
size, the cap-check `paidToArbiters + perArbiter <= totalPot` skips
payment entirely. With `perArbiterFeeBps` set above ~7.5% × 3 (e.g.,
3000 = 30%), arbiters silently receive **zero** pay; the entire pot
flows to party rebate.

A captured governance can effectively cancel arbiter compensation
without any on-chain warning, and arbiters won't notice until they
try to `claim`.

**Recommendation**. Cap `perArbiterFeeBps` to a safe ceiling in
`_validatePolicy` (e.g., `<= 500` = 5%). For the no-appeal path,
hardcode the 50/50 split between arbiter and rebate (it's already
implicit; just don't let governance reach it). Even better: add an
invariant assertion at distribution time that paid arbiters > 0 when
revealed arbiters exist.

**Lean**: cap `perArbiterFeeBps` at 1000 (10%) in `_validatePolicy`.
Same change for `appealFeeBps`. Three lines.

## H-02 — VRF-stuck cases have no on-chain remediation path

**Severity**: High (operational; case funds locked indefinitely).

**Location**: `Aegis.sol:finalize` (line ~905) — the catch-all
`revert CaseNotAwaitingPanel()` for `AwaitingArbiter` /
`AwaitingAppealPanel` states.

**Description**. If Chainlink VRF fails to fulfill a request (LINK
balance depleted, coordinator outage, key-hash mismatch), a case
sits in `AwaitingArbiter` or `AwaitingAppealPanel` forever. The
escrow funds (held in the underlying escrow contract, not Aegis)
are locked since `applyArbitration` never gets called. The
appellant's appeal fee (held in Aegis under `c.appealFeeAmount`)
is also locked.

There is no governance escape hatch:
- `setNewCasesPaused` only blocks new openDispute calls; doesn't
  affect existing cases.
- `withdrawTreasury` doesn't touch held appeal fees (those are
  case-scoped, not in `treasuryAccrued`).
- `setVrfConfig` lets you swap the coordinator but doesn't re-emit
  the request for stuck cases.

**Recommendation**. Add a governance-gated `forceCancelStuck(caseId)`:
- Only callable by `GOVERNANCE_ROLE`.
- Only callable if case is in `AwaitingArbiter` or
  `AwaitingAppealPanel` for > some threshold (e.g., 30 days).
- Releases any held appeal fee back to the appellant.
- Releases stake locks for any panel members who were drawn but
  never reached commit (currently zero in this state).
- Does NOT call `applyArbitration` — it's a manual cancel, not a
  default verdict. The underlying escrow's funds are recovered via
  whatever escape valve that escrow provides (Vaultra has its own
  expiry / DAO-rescue).
- Emits a `CaseCanceled` event for indexer.
- Clears `liveCaseFor` so a fresh dispute can be reopened.

**Lean**: high priority before mainnet. ~30 lines.

## M-01 — `_settleAppeal` pays arbiters first-come-first-served; a low-fee escrow may starve slot B

**Severity**: Medium (correctness; affects arbiter pay equity under non-default policy or non-Vaultra escrows).

**Location**: `Aegis.sol:_settleAppeal` lines 973–984.

**Description**. The per-arbiter cap-check
`paidToArbiters + perArbiter <= totalPot` runs sequentially:
original first, slot A second, slot B third. If `totalPot` is too
small to pay all three, slot B silently misses out while A and the
original are paid in full.

This is a non-issue under default Vaultra fees (totalPot exactly
equals 3 × perArbiter = 7.5%). It bites under:
- Non-Vaultra escrows that pay less than 5% of disputed amount.
- Governance policies that increase `perArbiterFeeBps` above what
  the integration's escrow fee actually delivers (related to H-01).

**Recommendation**. Either:
1. Pre-compute number of payable arbiters; split `totalPot`
   equally among them (drop the per-arbiter formula entirely on
   the appeal path).
2. Document explicitly that perArbiterFeeBps must be ≤ totalPot/N
   for all integrations, and add an assertion.

Option 1 is closer to D4 spirit and removes a class of bugs.

## M-02 — `applyArbitration` external call is reentrancy-resistant but worth flagging

**Severity**: Medium (defensive; no exploit found, but the pattern is unusual).

**Location**: `_settleNoAppeal` (line ~1141), `_settleAppeal` (line ~945), `_applyDefault` (line ~1063).

**Description**. All three settle paths call into the underlying
escrow's `applyArbitration` between balance reads:

```solidity
uint256 balBefore = IERC20(feeToken).balanceOf(address(this));
IArbitrableEscrow(c.escrow).applyArbitration(...);  // external call
uint256 balAfter = IERC20(feeToken).balanceOf(address(this));
uint256 received = balAfter - balBefore;
```

`finalize` is `nonReentrant`, so re-entry into `finalize` itself or
into `openDispute` / `requestAppeal` / `recuse` / `claim` is
blocked. But `commitVote`, `revealVote`, governance functions,
`stake`/`unstake`, and view functions are NOT under the same
guard. A malicious escrow could re-enter into one of these during
the `applyArbitration` call.

In all reachable cases the re-entry would have to come from
`msg.sender == c.escrow`, which is not an arbiter, party, or
governance — so concrete impact is negligible. But the pattern
violates strict CEI.

**Recommendation**. Either:
1. Pre-fetch `received` via a pull pattern: have the escrow `push`
   the fee to Aegis before calling Aegis back. (Major contract
   change; not worth it.)
2. Document that the escrow integration MUST not call back into
   Aegis during `applyArbitration`. Add it to
   `docs/integration-newdapps.md`.
3. Add a global `_inApplyArbitration` flag that blocks the few
   public functions not guarded by `nonReentrant` from being
   called during the window. (Cheap, defensive.)

**Lean**: option 3. Five lines.

## M-03 — `_arbiterList` iteration cost is O(N) per draw

**Severity**: Medium (gas / DoS at scale).

**Location**: `_eligibleArbiterCount` (line ~1267), `_drawArbiter`
(line ~1285).

**Description**. Both helpers iterate `_arbiterList` linearly. Every
case open, redraw, recuse, and `_eligibleArbiterCount` precheck pays
that cost. The cost lives inside `fulfillRandomWords`, which has a
fixed gas budget (`vrfConfig.callbackGasLimit`).

At ~100 arbiters this is ~30k gas per iteration's worth of state
reads — well within budget. At ~1000 arbiters it's ~300k, still OK.
Past ~3000 arbiters the callback may run out of gas, causing VRF
fulfillment to revert and the case to permanently stall (relates to
H-02).

The current Eclipse DAO arbiter pool is in the dozens, so this is
not an immediate concern. Flagged for future scaling.

**Recommendation**. Two options:
1. Add a hard cap on `_arbiterList.length` enforced in
   `registerArbiter` (e.g., 500). Governance can rotate arbiters.
2. Use a sortition tree / RNG-based commit-reveal that avoids
   iteration. Substantial rewrite; not v1.

**Lean**: option 1 with a generous cap (e.g., 500). One line in
`registerArbiter`.

## M-04 — `recuse()` uses `block.prevrandao` for replacement draw

**Severity**: Medium (collusion-grade attack; narrow exploit window).

**Location**: `Aegis.sol:recuse` lines 726, 754.

**Description**. The synchronous replacement draw on recuse uses
`block.prevrandao` as the seed. A block proposer who is also a
registered arbiter (or colluding with one) can in principle:
1. Recuse from a case.
2. Choose to include or exclude their own recuse transaction in a
   block whose prevrandao value selects a co-conspirator as the
   replacement.

The exploit requires:
- Being a block proposer at exactly the right slot.
- Being one of two parties: the recuser + a co-conspirator who's
  in the eligible pool.
- `_drawArbiter` to pick a specific arbiter from the pool, which
  depends on pool composition.

Practical attack cost is high (proposer slot timing, eligibility
constraints). But the property "recuse picks an unbiased
replacement" doesn't strictly hold.

**Recommendation**. Either:
1. Make recuse async — request VRF, transition the slot to
   "awaiting redraw", let the new VRF callback assign. Costs LINK
   per recuse, but symmetric with original draws.
2. Document that recuse is "best-effort random" and rely on the
   2-of-3 quorum + cooldown + 90-day exclusion to make the attack
   uneconomic.

**Lean**: option 2 — document. The 2-of-3 quorum on appeal already
contains this; for the original-phase recuse, the new arbiter still
must be honest enough to commit-reveal a sensible vote, and any
overturn happens through the regular appeal flow with VRF.
