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
