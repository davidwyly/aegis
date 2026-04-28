# Plugging a new escrow protocol into Aegis

Aegis arbitrates anything that implements `IArbitrableEscrow`. This is the
checklist for new escrow protocols; for Vaultra specifically there's
already an adapter — see `integration-vaultra.md`.

## The interface

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

`caseId` is opaque to Aegis. Pack whatever you need (escrowId, milestone
index, partition key) into 32 bytes — typically `keccak256(abi.encode(...))`
of your real key, with a side-table mapping back to the underlying state.

## Required behavior

1. **`active`**: return `false` once the dispute is settled or cancelled.
   Aegis refuses to open a case if `active == false`.
2. **`feeToken`**: the ERC20 your protocol pays the arbiter (Aegis) in.
   Aegis measures balance delta on itself at `applyArbitration` time, so
   the fee must arrive at Aegis's address (or an adapter that forwards
   to Aegis) within the same call.
3. **`applyArbitration` access control**: must accept calls from the
   address you set as arbiter on your escrow, which will be the Aegis
   address (or an adapter sitting between Aegis and your escrow).
4. **`partyA / partyB`**: distinct addresses; Aegis excludes both from
   the eligible-panelist pool when drawing. If your protocol can have
   more than two parties, pick the two whose interests are at stake on
   this specific dispute.

## Operationally

- Set Aegis as your contract's arbiter at funding time.
- Run a keeper that calls `Aegis.openDispute(yourContract, caseId)`
  whenever your protocol enters a disputed state.
- Listen for Aegis's `CaseResolved` / `CaseDefaultResolved` events to
  know when the verdict has landed; your `applyArbitration` will already
  have moved the funds.
