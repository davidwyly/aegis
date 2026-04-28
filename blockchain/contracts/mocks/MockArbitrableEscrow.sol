// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IArbitrableEscrow} from "../interfaces/IArbitrableEscrow.sol";

/**
 * @title MockArbitrableEscrow
 * @notice Bare-bones IArbitrableEscrow for testing Aegis end-to-end
 *         without pulling in Vaultra. Stores test-defined parties +
 *         amount + fee per case; pays out a pre-funded fee to the
 *         caller (Aegis) at applyArbitration time.
 */
contract MockArbitrableEscrow is IArbitrableEscrow {
    using SafeERC20 for IERC20;

    struct CaseData {
        address partyA;
        address partyB;
        address feeToken;
        uint256 amount;
        uint256 feeAmount; // amount to transfer to caller on applyArbitration
        bool active;
        bool resolved;
        uint16 partyAPercentage;
        bytes32 rationaleDigest;
    }

    mapping(bytes32 => CaseData) public cases;
    address public arbiter; // who is allowed to call applyArbitration

    event ArbitrationApplied(
        bytes32 indexed caseId,
        uint16 partyAPercentage,
        bytes32 rationaleDigest,
        uint256 feePaid
    );

    error NotArbiter();
    error CaseInactive();
    error AlreadyResolved();

    constructor(address _arbiter) {
        arbiter = _arbiter;
    }

    function setArbiter(address a) external {
        arbiter = a;
    }

    function setCase(
        bytes32 caseId,
        address partyA,
        address partyB,
        address feeToken,
        uint256 amount,
        uint256 feeAmount
    ) external {
        cases[caseId] = CaseData({
            partyA: partyA,
            partyB: partyB,
            feeToken: feeToken,
            amount: amount,
            feeAmount: feeAmount,
            active: true,
            resolved: false,
            partyAPercentage: 0,
            rationaleDigest: bytes32(0)
        });
    }

    function getDisputeContext(bytes32 caseId)
        external
        view
        override
        returns (
            address partyA,
            address partyB,
            address feeToken,
            uint256 amount,
            bool active
        )
    {
        CaseData storage c = cases[caseId];
        return (c.partyA, c.partyB, c.feeToken, c.amount, c.active);
    }

    function applyArbitration(
        bytes32 caseId,
        uint16 partyAPercentage,
        bytes32 rationaleDigest
    ) external override {
        if (msg.sender != arbiter) revert NotArbiter();
        CaseData storage c = cases[caseId];
        if (!c.active) revert CaseInactive();
        if (c.resolved) revert AlreadyResolved();

        c.resolved = true;
        c.active = false;
        c.partyAPercentage = partyAPercentage;
        c.rationaleDigest = rationaleDigest;

        if (c.feeAmount > 0) {
            IERC20(c.feeToken).safeTransfer(msg.sender, c.feeAmount);
        }

        emit ArbitrationApplied(caseId, partyAPercentage, rationaleDigest, c.feeAmount);
    }
}
