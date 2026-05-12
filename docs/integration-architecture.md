# Aegis integration architecture

The sibling Vaultra repo documents the integration from its own side in
[`docs/aegis-integration.md`](https://github.com/davidwyly/vaultra/blob/main/docs/aegis-integration.md).
This doc is the Aegis-side mirror: what surface Aegis exposes to a
routing protocol, how the Vaultra adapter shims that surface, and which
invariants must hold across the two repos.

The hands-on bring-up runbook (deploy order, VRF wiring, smoke test) is
[`integration-vaultra.md`](./integration-vaultra.md). For *new* escrow
protocols (anything that isn't Vaultra), the minimal interface contract
is [`integration-newdapps.md`](./integration-newdapps.md).

---

## 1. What Aegis exposes — `IArbitrableEscrow`

Aegis is escrow-agnostic. It talks to any contract that implements:

```solidity
interface IArbitrableEscrow {
    function getDisputeContext(bytes32 caseId)
        external view
        returns (
            address partyA,
            address partyB,
            address feeToken,
            uint256 amount,
            bool active
        );

    function applyArbitration(
        bytes32 caseId,
        uint16 partyAPercentage,
        bytes32 rationaleDigest
    ) external;
}
```

Four behavioral invariants the escrow side must hold:

1. **`active`** flips to `false` once the dispute is settled or
   cancelled. Aegis refuses `openDispute` when it's false.
2. **`feeToken`** is whatever ERC20 the protocol pays Aegis in. Aegis
   measures balance delta on itself at `applyArbitration` time, so the
   fee must land at Aegis's address inside that call (or at an adapter
   that forwards it on, like Vaultra's does).
3. **`applyArbitration` access control** must accept calls from the
   address registered as arbiter on the protocol side, which for the
   Aegis case is either the Aegis contract or an adapter sitting in
   front of it.
4. **`partyA` / `partyB`** are both non-zero. Aegis enforces non-zero
   in `openDispute` but does *not* check `partyA != partyB`; passing
   the same address for both is a misuse, not a revert — the
   panel-exclusion and pair-key logic still terminates, but the case
   is shaped degenerately.

---

## 2. The `VaultraAdapter` shim

Vaultra has two arbiter-callable resolve functions (milestone /
non-milestone) and identifies disputes by `(escrowId, milestoneIndex)`,
not `bytes32 caseId`. The adapter
([`blockchain/contracts/adapters/VaultraAdapter.sol`](../blockchain/contracts/adapters/VaultraAdapter.sol))
translates:

| Concern | Adapter behavior |
|---|---|
| Identity | Packs `(escrowId, milestoneIndex, noMilestone)` into a `bytes32 caseId` via `_packCaseId`. Stores the reverse mapping in `_cases`. |
| Arbiter slot | Acts as the registered arbiter on each Vaultra escrow, so the adapter is what Vaultra calls into on resolve. |
| Fee forwarding | Captures the ERC20 balance delta on itself during `applyArbitration` and forwards it to Aegis with `SafeERC20`, so Aegis's delta-based fee accounting captures the right amount. |
| Resolve dispatch | Calls `resolveDispute` vs `resolveDisputeNoMilestone` based on the flag stored at registration. |

`registerCase` is permissionless. It verifies the underlying escrow
has the adapter as arbiter and is in `Disputed` state before recording
the mapping. It does **not** verify that the specific
`(milestoneIndex, noMilestone)` tuple matches an actually-disputed
milestone — only escrow-level state is checked, while Vaultra's
`resolveDispute` requires `milestone.status == Disputed` at line 370.

The consequence is a known sharp edge: on an escrow with multiple
milestones where only milestone 0 has been disputed, anyone can call
`registerCase(escrowId, 1, false)` and `aegis.openDispute(...)`. VRF
fires, a panel seats, the case proceeds — and then `Aegis.finalize`
eventually calls `adapter.applyArbitration`, which calls
`vaultra.resolveDispute(escrowId, 1, ...)`, which reverts
`MilestoneNotDisputed`. The Aegis case is then stuck (every finalize
attempt reverts) until manual intervention.

Tightening this would mean either reading `getMilestone(escrowId, idx).status`
inside `registerCase`, or having `getDisputeContext` return `active=false`
when the referenced milestone isn't disputed (so `openDispute` refuses
to seat a panel in the first place). Filed as future hardening; the
current invariant is "trust the keeper to only register tuples seen in
a Vaultra `DisputeRaised` log."

---

## 3. The `caseId` contract

`caseId` is opaque to Aegis itself — it's whatever 32 bytes the adapter
emits — but for Vaultra it's a stable derivation that has to agree on
both sides of the integration:

```solidity
// Aegis side, on-chain (VaultraAdapter)
caseId = keccak256(abi.encode(
    bytes32 escrowId,
    uint256 milestoneIndex,
    bool    noMilestone
))
```

```ts
// Vaultra side, off-chain (lib/aegis.ts:computeAegisCaseId)
keccak256(encodeAbiParameters(
  parseAbiParameters("bytes32, uint256, bool"),
  [escrowId, milestoneIndex, noMilestone],
))
```

These must stay byte-identical. The pairing is checked by the
`AegisVaultraIntegration` Hardhat suite on this side, and by
`lib/aegis.test.ts` on Vaultra's side.

`milestoneIndex === null` on Vaultra maps to
`(milestoneIndex = 0, noMilestone = true)`, matching how the keeper
converts `DisputeRaisedNoMilestone` events into `registerCase` calls.

---

## 4. The keeper bridge

[`lib/keeper/service.ts`](../lib/keeper/service.ts) — one tick:

1. Read `indexer_state` cursor for
   `(chainId, vaultraAddress, "DisputeRaised")`.
2. Pull `DisputeRaised` + `DisputeRaisedNoMilestone` logs from Vaultra
   between cursor and tip.
3. For each, derive the expected `caseId` from
   `adapter.packCaseId(...)`. Read back `adapter.caseInfo(caseId)` to
   skip if already registered, else call `adapter.registerCase`.
4. Check `aegis.liveCaseFor(adapter, caseId)` — if non-zero, another
   tick already opened it; skip. Else call `aegis.openDispute`.
5. Pull the resulting case state back with `aegis.getCase` and mirror
   into the DB via `recordCaseOpened` (idempotent on
   `(chainId, aegisAddress, caseId)`).
6. Run `indexAegisEvents` to mirror Aegis's own events
   (`CaseRequested`, `CaseOpened`, `ArbiterDrawn`, commits, reveals,
   resolutions, slashing, panel redraws).
7. Run `autoFinalizePending` to sweep stalled cases whose reveal+grace
   windows have closed.
8. Advance the cursor to the scanned tip.

The bridge is **single-(chain, adapter, vaultra) per process**. Multiple
adapters on the same chain need multiple keeper processes — there's no
multi-adapter sweep inside one tick. Idempotency is the load-bearing
property:

- `recordCaseOpened` upserts on the case key.
- `indexer_state` cursor prevents replay.
- Per-event handlers in `aegis-indexer.ts` use
  `.onConflictDoNothing()` on the rows they could re-insert (e.g.
  `panel_members` on `ArbiterDrawn`).

---

## 5. Adapter rotation

The Vaultra side maintains a comma-separated list of *current + historical*
adapter addresses so its routing predicate stays correct across
redeploys (see Vaultra's
[`docs/aegis-integration.md` §1-2](https://github.com/davidwyly/vaultra/blob/main/docs/aegis-integration.md#1-activation)).

The Aegis side does **not** need an equivalent list. Each case row in
the Aegis DB stores its `escrow` (the adapter address it was opened
against) on `cases.escrow_address`. When the Vaultra operator rotates
to a new adapter, Aegis ends up with cases pointing at both addresses —
which is correct, because the old adapter is still the one that owns
the live-on-Vaultra arbitration mapping for those cases.

Operationally:

- Deploy a new `VaultraAdapter` pointing at the same Aegis instance.
- Run a second keeper process configured for the new adapter +
  Vaultra. The old keeper can keep running until its cases all close.
- Vaultra's env adds the new adapter address to the *head* of its
  comma-separated list, keeping the old address in the tail.
- No DB-side migration on Aegis. The `chains.ts` env stays single-valued
  per chain; if the UI ever needs to switch which adapter it points at,
  that's a redeploy of the Aegis app.

---

## 6. Cross-repo invariants

These are properties no single repo can verify on its own:

1. **`computeAegisCaseId` (Vaultra)** must produce the same bytes as
   **`VaultraAdapter._packCaseId` (Aegis)**. Checked in tests on both
   sides; only enforced by code review on the pairing.
2. **`blockchain/contracts/integration-fixtures/VaultraEscrow.sol`
   (Aegis)** must stay identical to
   **`blockchain/contracts/VaultraEscrow.sol` (Vaultra)** except for
   the 5-line vendoring header. The Aegis fork-integration test
   (`AegisVaultraForkIntegration`) is the regression net.
3. **Vaultra's `eclipseDAO` slot** is what gets pointed at the deployed
   adapter (`vaultra.updateEclipseDAO(adapter)`). New Vaultra escrows
   pick up `arbiter = adapter` from that slot; existing escrows keep
   their original arbiter. Aegis never reads this slot directly — it
   trusts the adapter to be the registered arbiter on the escrows it
   was registered against.
4. **Fee plumbing**: Vaultra pays the 2.5%–5% arbiter cut to the
   adapter on resolve; the adapter forwards to Aegis in the same call;
   Aegis splits the pot per `_settleNoAppeal` / `_settleAppeal` in
   `blockchain/contracts/Aegis.sol`. As implemented today:
   - **No-appeal path**: 50% to the original arbiter, 50% rebated to
     the parties pro-rata by verdict percentage.
   - **Appeal path**: each revealing arbiter receives
     `policy.perArbiterFeeBps` of `c.amount` (or an equal share of the
     pot when it can't satisfy the target); if no appeal arbiter
     revealed, the appellant's appeal bond is refunded; remainder
     rebated to the parties pro-rata by the final verdict.
   - **Treasury** receives `0` from `FeesAccrued` today — the
     contract emits the slot but the implementation pays no treasury
     cut on resolve. Slashed bonds (from missed reveals) are the only
     path that currently funds the treasury.

   If any forwarding step stops, the on-chain `getCase().feesDistributed`
   flag won't flip — there's no out-of-band reconciliation.

**When you touch `vaultra/blockchain/contracts/VaultraEscrow.sol`:**

1. Recompile and re-export the ABI on the Vaultra side.
2. Copy the new contract body over the vendored Aegis fixture
   (preserve the 5-line vendoring header).
3. In this repo, run `pnpm contracts:test` and the fork test (with
   `BASE_SEPOLIA_FORK_URL` set) to confirm the adapter still
   integrates cleanly.

---

## 7. Observability

The integration is intentionally narrow — no separate "this case is
Vaultra-routed" event from Aegis. To audit operational health:

| Surface | What it shows |
|---|---|
| `/admin` indexer cursor | Lag per `(contract, eventName)`. Bridge cursor is `(vaultra, "DisputeRaised")`. |
| `/admin/failures` | Disputes the keeper couldn't bridge, with reason + attempt count. Cleared automatically once `openDispute` lands. |
| `cases.escrow_address` | Adapter the case was opened against — distinguishes pre/post-rotation cases without a separate column. |
| `getCase(...).feesDistributed` (on-chain) | Whether the post-`applyArbitration` fee split has run. The DB doesn't mirror this flag — `cases.resolved_at` is the DB-side proxy for "case has fully settled." |
| VRF subscription LINK balance | Out-of-LINK ⇒ `openDispute` reverts; admin shows a "VRF stuck" count for cases in `awaiting_panel` > 1h. |

For a specific case, the route from Vaultra → Aegis is fully derivable:
`Aegis.liveCaseFor(adapter, packCaseId(escrowId, milestoneIndex, noMilestone))`
returns the live `caseId`, and `getCase` gives the on-chain state. The
DB mirror is a convenience for the UI, not a source of truth.

---

## 8. What to add when extending the integration

Any code change that touches the Vaultra-routing surface should:

1. Keep `VaultraAdapter._packCaseId` and Vaultra's `computeAegisCaseId`
   byte-aligned. Tests on each side lock the derivation; the pairing
   is only enforced by review.
2. Re-vendor `VaultraEscrow.sol` if the upstream public surface
   changes — the adapter's `IVaultraEscrow` interface and the
   integration tests both read from the fixture.
3. Add new event handlers in `lib/keeper/aegis-indexer.ts`, not in
   `service.ts` — the indexer is the place where idempotency, cursor
   advancement, and DB mirroring already line up.
4. Use `recordCaseOpened` / `recordCaseRequested` for any new
   case-creation path. They upsert on
   `(chainId, aegisAddress, caseId)`; don't insert into `cases`
   directly.
5. If you add a new flag the keeper depends on (a new Vaultra event,
   a new adapter field), document it in this file and in Vaultra's
   `aegis-integration.md` — the two repos drift fastest in places only
   one of them knows about.
