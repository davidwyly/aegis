// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IArbitrableEscrow
 * @notice Minimal interface that any escrow protocol implements so an
 *         external court (Aegis) can arbitrate its disputes.
 *
 * The escrow protocol assigns the court contract address as the
 * authoritative arbiter on its in-flight cases. When the court reaches
 * a verdict it calls back into `applyArbitration`, which the escrow
 * protocol uses to settle funds.
 *
 * `caseId` is opaque to the court — the escrow protocol packs whatever
 * disambiguation it needs (e.g. escrowId + milestoneIndex) and is
 * responsible for unpacking it on the way back in.
 */
interface IArbitrableEscrow {
    /**
     * @notice Read-only context for a dispute the court is opening.
     * @param caseId Escrow-protocol-specific case identifier.
     * @return partyA Address of the first named party (e.g. client).
     * @return partyB Address of the second named party (e.g. worker).
     * @return feeToken ERC20 in which the arbitration fee will be paid to the court.
     * @return amount Total disputed amount, in the escrow's settlement token.
     * @return active True if the on-chain dispute is still open and arbitrable.
     */
    function getDisputeContext(bytes32 caseId)
        external
        view
        returns (
            address partyA,
            address partyB,
            address feeToken,
            uint256 amount,
            bool active
        );

    /**
     * @notice Apply the court's verdict.
     *         MUST revert unless `msg.sender` is the configured arbiter for
     *         the underlying escrow.
     * @param caseId Same opaque identifier as `getDisputeContext`.
     * @param partyAPercentage 0–100 — share of the disputed amount paid to partyA.
     *                         The remainder goes to partyB.
     * @param rationaleDigest EIP-712 digest committing the panel's rationale.
     */
    function applyArbitration(
        bytes32 caseId,
        uint16 partyAPercentage,
        bytes32 rationaleDigest
    ) external;
}
