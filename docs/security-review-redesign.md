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

## L-01 — `_releaseLock` "snap to 0" can mask accounting drift

**Location**: `Aegis.sol:_releaseLock` line 1106.

```solidity
lockedStake[arbiter] = cur > amount ? cur - amount : 0;
```

If a bug ever causes `_releaseLock` to be called twice for the same
draw (or with the wrong `amount`), the second call clamps to 0 and
silently corrupts accounting. Subsequent `unstake` calls would then
be allowed for stake that's still bonded to active cases.

**Recommendation**. Change to a strict assertion:
```solidity
require(cur >= amount, "lock underflow");
lockedStake[arbiter] = cur - amount;
```
Aborts the tx on accounting drift, surfacing the bug immediately.

## L-02 — Median-of-2 floor rounding favors lower party

**Location**: `Aegis.sol:_medianOf2` line 1098.

`floor((a + b) / 2)` for an odd sum rounds down by 0.5 percentage
point. Per D6 this is the locked design choice, but worth a
user-visible note in `docs/arbitration-redesign.md` so parties
understand that an E3 partial reveal can shift the median by ±0.5pp
relative to the arithmetic mean.

**Recommendation**. Documentation only.

## L-03 — `setPolicy` accepts extreme window values without sanity bounds

**Location**: `Aegis.sol:_validatePolicy` line 423.

The policy validator only rejects `commitWindow == 0`,
`revealWindow == 0`, `appealWindow == 0`. A captured governance
could `setPolicy({commitWindow: 1, revealWindow: 1, ...})` to make
the system effectively unusable (arbiters can't act in 1-second
windows). Or set windows to `type(uint64).max` to keep cases live
for centuries.

Mitigated by the timelock on `Governance.sol`, but defense in depth
suggests bounds:
- `commitWindow` and `revealWindow` between 1 hour and 30 days.
- `appealWindow` between 1 day and 30 days.
- `repeatArbiterCooldown` ≤ 5 years.

**Recommendation**. Add range checks. ~10 lines in `_validatePolicy`.

## L-04 — `Stalled` events emit `slashedTotal` as `stakeRequirement` regardless of actual slash

**Location**: `Aegis.sol:_stallOriginal` lines 1046, 1051.

```solidity
emit Stalled(caseId, 0, p.stakeRequirement);
```

The third arg is documented as `slashedTotal`, but `_slashArbiter`
caps the actual slash at the arbiter's available stake. If the
arbiter has been partially slashed earlier (impossible under current
flow, but possible if combined with future features), the event's
declared "slashed" amount won't match what `treasuryAccrued`
actually grew by.

**Recommendation**. Have `_slashArbiter` return the actual slashed
amount; pass it to the `Stalled` emit.

## I-01 — Frontrunning `openDispute` is harmless

`openDispute` is permissionless. A keeper might be racing other
keepers to open the same dispute; the second tx reverts
`CaseAlreadyLive` cleanly. No exploit.

## I-02 — Fee-on-transfer fee tokens are correctly handled

The balance-delta pattern (`balAfter - balBefore`) credits whatever
amount actually arrived, not the amount the escrow `applyArbitration`
intended to send. If the fee token charges 0.5% transfer tax, Aegis
just distributes the post-tax amount. The arbiter and parties get
slightly less; no loss to Aegis, no panic.

## I-03 — Per-case appeal fees held in escrow's fee token

If the fee token (e.g., USDC) blacklists Aegis's address mid-case,
then:
- Outgoing transfers (claim, party rebate) revert.
- Locked appeal fees are stuck.

This is a USDC compliance failure mode shared by every contract
that holds USDC. Not Aegis-specific. Worth a sentence in trust
assumptions.

## Recommended mitigation order

If you do nothing else before mainnet, do these:

1. **H-02 force-cancel escape** — without this, a single VRF outage
   permanently bricks affected cases. Add `forceCancelStuck` with a
   30-day delay + governance role.
2. **H-01 perArbiterFeeBps cap** — three-line patch in
   `_validatePolicy`. Removes a class of governance-capture-induced
   pay denial.
3. **L-01 strict require in `_releaseLock`** — converts a silent
   accounting bug into a loud one. One line.
4. **M-03 hard cap on `_arbiterList.length`** — defensive against
   future scaling-induced VRF gas-out.
5. **L-03 policy bounds** — defense in depth; add the range checks.

After those, schedule the external audit. M-01, M-02, M-04, L-02,
L-04, and the I-* items can be addressed during the audit cycle or
deferred.

## What was NOT found

For the record — areas examined and cleared:

- **Reentrancy in `claim`, `stake`, `unstake`, `withdrawTreasury`**:
  all use CEI + `nonReentrant`. ✓
- **Integer overflow in fee math**: amounts × bps fit in uint256
  with safe Solidity 0.8 checks. ✓
- **uint16 truncation in `_medianOf2`**: sum ≤ 200, well within
  uint16. revealVote enforces percentage ≤ 100. ✓
- **Modulo bias in `_drawArbiter`**: seed is uint256, n is small;
  bias is negligible. ✓
- **Two simultaneous `commitVote` from same arbiter**: second
  reverts `AlreadyCommitted`. ✓
- **Two simultaneous `finalize`**: state-machine guards reject the
  second. ✓
- **D12 enforcement off-by-one**: `partyAPercentage == 100`
  excludes partyA correctly; `== 0` excludes partyB. Compromise
  verdicts (1..99) admit either. Tested. ✓
- **D13 cooldown bypass via party order**: `_partyPairKey`
  canonicalizes (a, b) → keccak(min, max). Symmetric. ✓
- **`liveCaseFor` cleanup on stall**: not cleared on round-0 stall
  (correct; case still live), cleared on round-1 default and
  resolution. ✓
- **`escrowCaseId` vs `aegisCaseId`** confusion: contract correctly
  passes `c.escrowCaseId` to `applyArbitration` (fixed bug from
  earlier review pass). Tested. ✓

## Notes for the external auditor

- Read `docs/arbitration-redesign.md` first — it's the spec the
  contract was written from. Decisions D1–D16 are referenced
  throughout.
- `docs/ux-design.md` covers the de novo blindness property the
  frontend enforces; the contract's role is to make sure phase
  context isn't on-chain-derivable beyond what's strictly necessary
  for state transitions.
- All 26 contract tests in `blockchain/test/Aegis.test.ts` are the
  intended-behavior spec. If a finding contradicts a test, please
  flag.
- This redesign replaced a 1637-line v0 contract with 1488 lines.
  The v0 audit is in `docs/security-review.md` — most of its
  findings don't apply (different attack surface) but the trust
  assumptions still do.
