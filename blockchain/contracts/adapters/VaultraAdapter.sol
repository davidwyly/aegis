// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IArbitrableEscrow} from "../interfaces/IArbitrableEscrow.sol";

/**
 * @title IVaultraEscrow
 * @notice Minimal slice of VaultraEscrow that this adapter calls into.
 *         Field order matches `getEscrow()` in
 *         /home/dwyly/code/vaultra/blockchain/contracts/VaultraEscrow.sol.
 */
interface IVaultraEscrow {
    function token() external view returns (IERC20);

    function getEscrow(bytes32 escrowId)
        external
        view
        returns (
            string memory title,
            string memory description,
            address client,
            address worker,
            address arbiter,
            uint256 totalAmount,
            uint256 releasedAmount,
            uint256 feeAmount,
            uint8 status, // 0=Active, 1=Completed, 2=Disputed, 3=Cancelled
            uint256 createdAt,
            bool hasMilestones,
            uint256 milestonesCount
        );

    function getMilestone(bytes32 escrowId, uint256 milestoneIndex)
        external
        view
        returns (string memory title, uint256 amount, uint8 status);

    function resolveDispute(
        bytes32 escrowId,
        uint256 milestoneIndex,
        uint256 clientPercentage,
        bytes32 rationaleDigest
    ) external;

    function resolveDisputeNoMilestone(
        bytes32 escrowId,
        uint256 clientPercentage,
        bytes32 rationaleDigest
    ) external;
}

/**
 * @title VaultraAdapter
 * @notice IArbitrableEscrow shim for VaultraEscrow.
 *
 * Vaultra has two arbiter-callable resolve functions (milestone and
 * non-milestone) and identifies disputes by `(escrowId, milestoneIndex)`.
 * Aegis only knows `bytes32 caseId`. This adapter:
 *
 *   1. Maps Aegis-side `caseId` → Vaultra-side `(escrowId, milestoneIndex,
 *      isNoMilestone)`.
 *   2. Acts as the registered arbiter on Vaultra escrows so it can call
 *      the correct resolve function.
 *   3. Forwards the arbitration fee Vaultra pays it on to Aegis at
 *      `applyArbitration` time, so Aegis's balance-delta accounting works.
 *
 * Deployment flow:
 *   - Deploy this adapter pointing at a specific Aegis instance and a
 *     specific VaultraEscrow instance.
 *   - Call `vaultra.updateEclipseDAO(adapterAddress)` so new escrows
 *     default `arbiter = adapter`. (Existing escrows keep their old
 *     arbiter — only freshly-created ones plug in.)
 *   - Anyone can then call `adapter.openCase(escrowId, milestoneIndex,
 *     isNoMilestone)` once a dispute has been raised on Vaultra; this
 *     opens the matching case on Aegis.
 */
contract VaultraAdapter is IArbitrableEscrow {
    using SafeERC20 for IERC20;

    uint8 private constant VAULTRA_STATUS_DISPUTED = 2;
    // MilestoneStatus enum on VaultraEscrow: Pending=0, Released=1, Disputed=2.
    uint8 private constant VAULTRA_MILESTONE_STATUS_DISPUTED = 2;

    address public immutable aegis;
    IVaultraEscrow public immutable vaultra;

    struct CaseInfo {
        bytes32 escrowId;
        uint256 milestoneIndex;
        bool noMilestone;
        bool registered;
    }

    mapping(bytes32 => CaseInfo) private _cases;

    event CaseRegistered(
        bytes32 indexed caseId,
        bytes32 indexed escrowId,
        uint256 milestoneIndex,
        bool noMilestone
    );

    error ZeroAddress();
    error OnlyAegis();
    error UnknownCase();
    error NotArbiter();
    error NotDisputed();
    error AlreadyRegistered();
    error MilestoneShapeMismatch();
    error InvalidMilestoneIndex();
    error MilestoneNotDisputed();

    constructor(address _aegis, IVaultraEscrow _vaultra) {
        if (_aegis == address(0)) revert ZeroAddress();
        if (address(_vaultra) == address(0)) revert ZeroAddress();
        aegis = _aegis;
        vaultra = _vaultra;
    }

    // ============================================================
    // Case registration (called by keeper, not Aegis)
    // ============================================================

    /**
     * @notice Register a Vaultra dispute for arbitration and open the case
     *         on Aegis. Permissionless: anyone can do this once Vaultra
     *         has flipped the escrow to Disputed.
     * @return caseId The Aegis-side case identifier.
     */
    function registerCase(
        bytes32 escrowId,
        uint256 milestoneIndex,
        bool noMilestone
    ) external returns (bytes32 caseId) {
        // Confirm the underlying escrow has us as arbiter and is disputed.
        (
            ,
            ,
            ,
            ,
            address arbiter,
            ,
            ,
            ,
            uint8 status,
            ,
            bool hasMilestones,
            uint256 milestonesCount
        ) = vaultra.getEscrow(escrowId);
        if (arbiter != address(this)) revert NotArbiter();
        if (status != VAULTRA_STATUS_DISPUTED) revert NotDisputed();

        // Match Vaultra's resolveDispute* dispatch shape. Without these
        // checks, anyone could register a case for a non-disputed milestone
        // (or with the wrong shape), seat a panel via openDispute, then
        // every finalize attempt reverts at vaultra.resolveDispute*. The
        // VRF request gets burned and the Aegis case sits stuck.
        if (noMilestone) {
            if (hasMilestones) revert MilestoneShapeMismatch();
        } else {
            if (!hasMilestones) revert MilestoneShapeMismatch();
            if (milestoneIndex >= milestonesCount) revert InvalidMilestoneIndex();
            (, , uint8 milestoneStatus) = vaultra.getMilestone(escrowId, milestoneIndex);
            if (milestoneStatus != VAULTRA_MILESTONE_STATUS_DISPUTED) {
                revert MilestoneNotDisputed();
            }
        }

        caseId = _packCaseId(escrowId, milestoneIndex, noMilestone);
        if (_cases[caseId].registered) revert AlreadyRegistered();

        _cases[caseId] = CaseInfo({
            escrowId: escrowId,
            milestoneIndex: milestoneIndex,
            noMilestone: noMilestone,
            registered: true
        });

        emit CaseRegistered(caseId, escrowId, milestoneIndex, noMilestone);
    }

    function caseInfo(bytes32 caseId)
        external
        view
        returns (bytes32 escrowId, uint256 milestoneIndex, bool noMilestone, bool registered)
    {
        CaseInfo storage ci = _cases[caseId];
        return (ci.escrowId, ci.milestoneIndex, ci.noMilestone, ci.registered);
    }

    function packCaseId(bytes32 escrowId, uint256 milestoneIndex, bool noMilestone)
        external
        pure
        returns (bytes32)
    {
        return _packCaseId(escrowId, milestoneIndex, noMilestone);
    }

    function _packCaseId(bytes32 escrowId, uint256 milestoneIndex, bool noMilestone)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(escrowId, milestoneIndex, noMilestone));
    }

    // ============================================================
    // IArbitrableEscrow
    // ============================================================

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
        CaseInfo storage ci = _cases[caseId];
        if (!ci.registered) revert UnknownCase();

        (
            ,
            ,
            address client,
            address worker,
            ,
            uint256 totalAmount,
            ,
            ,
            uint8 status,
            ,
            ,

        ) = vaultra.getEscrow(ci.escrowId);

        feeToken = address(vaultra.token());
        active = (status == VAULTRA_STATUS_DISPUTED);

        if (ci.noMilestone) {
            amount = totalAmount;
        } else {
            (, uint256 milestoneAmount, ) = vaultra.getMilestone(ci.escrowId, ci.milestoneIndex);
            amount = milestoneAmount;
        }

        // partyA = client, partyB = worker.
        partyA = client;
        partyB = worker;
    }

    function applyArbitration(
        bytes32 caseId,
        uint16 partyAPercentage,
        bytes32 rationaleDigest
    ) external override {
        if (msg.sender != aegis) revert OnlyAegis();
        CaseInfo storage ci = _cases[caseId];
        if (!ci.registered) revert UnknownCase();

        IERC20 feeToken = vaultra.token();
        uint256 balBefore = feeToken.balanceOf(address(this));

        if (ci.noMilestone) {
            vaultra.resolveDisputeNoMilestone(ci.escrowId, partyAPercentage, rationaleDigest);
        } else {
            vaultra.resolveDispute(
                ci.escrowId,
                ci.milestoneIndex,
                partyAPercentage,
                rationaleDigest
            );
        }

        // Forward the arbitration fee Vaultra paid us on to Aegis so its
        // balance-delta accounting captures the right amount.
        uint256 balAfter = feeToken.balanceOf(address(this));
        if (balAfter > balBefore) {
            feeToken.safeTransfer(aegis, balAfter - balBefore);
        }
    }
}
