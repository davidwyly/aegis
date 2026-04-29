// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IArbitrableEscrow} from "./interfaces/IArbitrableEscrow.sol";

// ================================================================
// Chainlink VRF v2 — minimal hand-rolled interface so we don't pull
// in @chainlink/contracts. The shape mirrors VRFCoordinatorV2 +
// VRFConsumerBaseV2 exactly; deploy-time config (key hash, sub id,
// confirmations, callback gas) lives in `VrfConfig` below.
// ================================================================

interface IVRFCoordinator {
    function requestRandomWords(
        bytes32 keyHash,
        uint64 subId,
        uint16 minimumRequestConfirmations,
        uint32 callbackGasLimit,
        uint32 numWords
    ) external returns (uint256 requestId);
}

abstract contract VRFConsumer {
    address public immutable vrfCoordinator;

    error OnlyVRFCoordinator();

    constructor(address _vrfCoordinator) {
        vrfCoordinator = _vrfCoordinator;
    }

    /// @notice Public entry point Chainlink calls back on. Restricts to
    /// the configured coordinator and forwards to the implementer's hook.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != vrfCoordinator) revert OnlyVRFCoordinator();
        fulfillRandomWords(requestId, randomWords);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal virtual;
}

/**
 * @title Aegis
 * @notice Eclipse-DAO-administered arbitration court. Escrow protocols
 *         (Vaultra and others) implement IArbitrableEscrow and assign
 *         this contract as their arbiter. Aegis maintains a registered,
 *         ELCP-staked roster of human arbiters; for each dispute it
 *         draws a panel pseudorandomly, runs commit-reveal voting, and
 *         calls back into the escrow with the median verdict.
 *
 * Key design choices:
 *   - GOVERNANCE_ROLE granted to Eclipse DAO `Governance.sol`. All
 *     roster + policy changes flow through DAO proposals.
 *   - Stake is a single ELCP-denominated balance held inside this
 *     contract (no vote-escrow coupling for v1).
 *   - Panel size is odd (3, 5, or 7) so median resolves cleanly.
 *   - Two-round timeout fallback: round 0 stall slashes non-revealers
 *     and redraws; round 1 stall settles 50/50 on the underlying
 *     escrow as a deterministic last resort.
 *   - Fees received from the escrow at `applyArbitration` time are
 *     split panelFeeBps to revealing panelists (equal share) and
 *     remainder to a governance-controlled treasury.
 */
contract Aegis is AccessControl, ReentrancyGuard, VRFConsumer {
    using SafeERC20 for IERC20;

    // ============================================================
    // Roles & constants
    // ============================================================

    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    uint16 public constant BPS_DENOMINATOR = 10_000;
    uint16 public constant DEFAULT_PERCENTAGE = 50; // 50/50 fallback

    /// @dev Stake is denominated in ELCP. Held by this contract.
    IERC20 public immutable stakeToken;

    // ============================================================
    // VRF — governance-tunable subscription parameters
    // ============================================================

    struct VrfConfig {
        bytes32 keyHash;
        uint64 subscriptionId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
    }

    VrfConfig public vrfConfig;

    /// @notice One pending request per case, until VRF callback lands.
    mapping(uint256 requestId => bytes32 caseId) public requestToCase;

    // ============================================================
    // Policy (governance-tunable)
    // ============================================================

    struct Policy {
        uint64 commitWindow; // commit phase length, seconds (D7)
        uint64 revealWindow; // reveal phase length, seconds (D8)
        uint64 graceWindow; // grace before slashing on stall, seconds
        uint64 appealWindow; // appeal-eligibility window post original-reveal (D9)
        uint64 repeatArbiterCooldown; // seconds an arbiter is excluded from same-parties cases (D13)
        uint256 stakeRequirement; // minimum stake to be eligible
        uint16 appealFeeBps; // appeal fee in escrow's fee token, bps of disputed amount (D2)
        uint16 perArbiterFeeBps; // per-arbiter share on appealed cases, bps (2.5% per D4)
        address treasury; // recipient for slashed bonds + treasury portions
    }

    Policy public policy;
    bool public newCasesPaused;

    // ============================================================
    // Arbiter roster
    // ============================================================

    struct Arbiter {
        bool active;
        uint96 stakedAmount;
        uint64 listIndex; // index into arbiterList; for swap-pop removal
        uint64 caseCount; // monotonic counter for transparency
        bytes32 credentialCID; // off-chain credential pointer (e.g. IPFS)
    }

    mapping(address => Arbiter) public arbiters;
    address[] private _arbiterList;

    /// @notice Stake an arbiter has committed to active panels — sum of
    /// `stakeRequirement` across every case they're currently sitting on.
    /// `unstake` and panel-eligibility both consult this so an arbiter
    /// can't drain their stake mid-case to dodge slashing.
    mapping(address => uint96) public lockedStake;

    // ============================================================
    // Cases
    //
    // Single-arbiter original verdict + 2-arbiter appeal augmentation
    // (median of 3 if appealed). State names are phase-agnostic by
    // design — appeal arbiters drawn under de novo review see the
    // same `Voting`/`Revealing` state as original arbiters. The phase
    // is inferred internally from `originalRevealed`.
    // ============================================================

    enum CaseState {
        None,
        AwaitingArbiter, // VRF requested; arbiter not yet drawn
        Voting, // commit + reveal window (sub-windows gated by deadlines)
        AppealableResolved, // original revealed; appeal window open
        AwaitingAppealPanel, // appeal requested; VRF for 2 new arbiters pending
        Resolved, // applyArbitration called; case closed
        Defaulted // 50/50 fallback applied after stall round 1
    }

    /// @notice One of two appeal-arbiter slots. Fixed-size to avoid
    /// dynamic-array gymnastics for a known-2 quorum extension.
    struct AppealSlot {
        address arbiter;
        bytes32 commitHash;
        uint16 partyAPercentage;
        bytes32 rationaleDigest;
        bool revealed;
    }

    struct Case {
        // Identity
        address escrow;
        bytes32 escrowCaseId;
        address partyA;
        address partyB;
        address feeToken;
        uint256 amount;
        uint64 openedAt;

        // State machine
        CaseState state;
        uint8 stallRound; // 0 first attempt, 1 redraw

        // Original arbiter slot
        address originalArbiter;
        bytes32 originalCommitHash;
        uint16 originalPercentage;
        bytes32 originalDigest;
        uint64 originalCommitDeadline;
        uint64 originalRevealDeadline;
        bool originalRevealed;

        // Appeal extension (zero unless appeal is filed)
        address appellant;
        uint64 appealDeadline; // when the appeal-eligibility window closes
        AppealSlot[2] appealSlots;
        uint64 appealCommitDeadline;
        uint64 appealRevealDeadline;
        uint256 appealFeeAmount; // held in escrow fee token until distribution

        // Pot accounting
        uint256 escrowFeeReceived; // populated when applyArbitration returns the fee
        bool feesDistributed;
    }

    mapping(bytes32 => Case) internal _cases;

    /// @notice Per-party-pair, per-arbiter timestamp of last assignment.
    /// Used to enforce the 90-day repeat-arbiter cooldown (D13). Keyed
    /// by `_partyPairKey(partyA, partyB)` so it's symmetric in party
    /// order.
    mapping(bytes32 => mapping(address => uint64)) public lastArbitratedAt;

    /// @notice Currently-active Aegis case ID for a given
    /// (escrow, escrowCaseId) pair. Set on `openDispute`, cleared on
    /// resolve / default-resolve. Prevents duplicate cases for the
    /// same underlying dispute.
    mapping(address => mapping(bytes32 => bytes32)) public liveCaseFor;

    /// @notice Pull-pattern fee balances. claimable[arbiter][token].
    mapping(address => mapping(address => uint256)) public claimable;

    /// @notice Treasury-accrued balances per token. Withdrawable by governance.
    mapping(address => uint256) public treasuryAccrued;

    uint256 private _caseNonce;

    /// @notice Canonical-ordered hash of a (partyA, partyB) pair. Used
    /// as the key for `lastArbitratedAt` so the cooldown is symmetric
    /// regardless of which side is partyA in a given case.
    function _partyPairKey(address a, address b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    // ============================================================
    // Events
    // ============================================================

    event ArbiterRegistered(address indexed arbiter, bytes32 credentialCID);
    event ArbiterRevoked(address indexed arbiter, uint256 slashedToTreasury);
    event StakeIncreased(address indexed arbiter, uint256 amount, uint256 newTotal);
    event StakeWithdrawn(address indexed arbiter, uint256 amount, uint256 newTotal);
    event PolicyUpdated(
        uint64 commitWindow,
        uint64 revealWindow,
        uint64 graceWindow,
        uint64 appealWindow,
        uint64 repeatArbiterCooldown,
        uint256 stakeRequirement,
        uint16 appealFeeBps,
        uint16 perArbiterFeeBps,
        address treasury
    );
    event NewCasesPaused(bool paused);
    event CaseRequested(
        bytes32 indexed caseId,
        address indexed escrow,
        bytes32 indexed escrowCaseId,
        address partyA,
        address partyB,
        address feeToken,
        uint256 amount,
        uint256 vrfRequestId
    );
    event CaseOpened(
        bytes32 indexed caseId,
        address indexed escrow,
        bytes32 indexed escrowCaseId,
        address partyA,
        address partyB,
        address feeToken,
        uint256 amount
    );
    event VrfConfigUpdated(bytes32 keyHash, uint64 subscriptionId, uint16 confirmations, uint32 callbackGasLimit);

    /// @notice Emitted whenever an arbiter is assigned to a case slot
    /// — original draw, appeal-slot draw, or stall-redraw replacement.
    /// Phase-agnostic by design (de novo review). The phase is
    /// recoverable from `_cases[caseId].state` at the time of emit
    /// but is intentionally NOT in the event payload.
    event ArbiterDrawn(bytes32 indexed caseId, address indexed arbiter);

    /// @notice Replacement of a previously-assigned arbiter. Triggered
    /// by recuse or by stall-redraw. Same shape regardless of phase.
    event ArbiterRedrawn(bytes32 indexed caseId, address indexed previousArbiter, address indexed replacement);

    event Recused(bytes32 indexed caseId, address indexed recused, address indexed replacement);
    event Committed(bytes32 indexed caseId, address indexed arbiter, bytes32 commitHash);
    event Revealed(
        bytes32 indexed caseId,
        address indexed arbiter,
        uint16 partyAPercentage,
        bytes32 rationaleDigest
    );
    event Stalled(bytes32 indexed caseId, uint8 round, uint256 slashedTotal);
    event Slashed(address indexed arbiter, uint256 amount, bytes32 indexed caseId);
    event CaseResolved(
        bytes32 indexed caseId,
        uint16 finalPercentage,
        bytes32 finalDigest
    );
    event CaseDefaultResolved(bytes32 indexed caseId, uint16 fallbackPercentage);
    event FeesAccrued(
        bytes32 indexed caseId,
        address feeToken,
        uint256 totalReceived,
        uint256 arbiterTotal,
        uint256 partyRebateTotal,
        uint256 treasuryAmount
    );
    event FeesClaimed(address indexed arbiter, address indexed token, uint256 amount);
    event TreasuryWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @notice Appeal filed by a party. Emits the fee amount in the
    /// escrow's fee token (not ELCP — the appeal fee is denominated in
    /// the disputed-amount token under the new design).
    event AppealRequested(
        bytes32 indexed caseId,
        address indexed appellant,
        uint256 feeAmount,
        address feeToken,
        uint256 vrfRequestId
    );

    /// @notice Pro-rata refund of unspent dispute pot to the prevailing
    /// party (or split between parties on a compromise verdict). See D1(c).
    event PartyRebated(bytes32 indexed caseId, address indexed party, address indexed token, uint256 amount);

    // ============================================================
    // Errors
    // ============================================================

    error ZeroAddress();
    error InvalidPolicy();
    error AlreadyActive();
    error NotActive();
    error InsufficientStake();
    error CasePaused();
    error CaseExists();
    error CaseNotFound();
    error CaseNotOpen();
    error CaseNotRevealing();
    error CaseAlreadyFinalized();
    error NotPanelist();
    error AlreadyCommitted();
    error NoCommit();
    error AlreadyRevealed();
    error CommitMismatch();
    error InvalidPercentage();
    error CommitWindowOpen();
    error CommitWindowClosed();
    error RevealWindowOpen();
    error RevealWindowClosed();
    error GraceWindowOpen();
    error NotEnoughArbiters();
    error EscrowReportsInactive();
    error TokenMismatch();
    error InsufficientTreasury();
    error NothingToClaim();
    error AmountTooLarge();
    error CaseNotAppealable();
    error AppealWindowClosed();
    error AppealWindowOpen();
    error AppealAlreadyExists();
    error AppealantNotParty();
    error AppealCommitClosed();
    error AppealRevealClosed();
    error NotAppealPanelist();
    error StakeLocked();
    error CannotRecuseAfterCommit();
    error CaseAlreadyLive();
    error UnknownVrfRequest();
    error CaseNotAwaitingPanel();
    error CaseNotInVotingState();
    error NotAssignedArbiter();
    error FullWinnerCannotAppeal();
    error NotImplemented();

    // ============================================================
    // Constructor
    // ============================================================

    constructor(
        address governance,
        IERC20 _stakeToken,
        address _vrfCoordinator,
        VrfConfig memory _vrfConfig,
        Policy memory _policy
    ) VRFConsumer(_vrfCoordinator) {
        if (governance == address(0)) revert ZeroAddress();
        if (address(_stakeToken) == address(0)) revert ZeroAddress();
        if (_vrfCoordinator == address(0)) revert ZeroAddress();
        _validatePolicy(_policy);

        stakeToken = _stakeToken;
        policy = _policy;
        vrfConfig = _vrfConfig;

        _grantRole(DEFAULT_ADMIN_ROLE, governance);
        _grantRole(GOVERNANCE_ROLE, governance);
    }

    /// @notice Governance can update the VRF subscription parameters
    /// without redeploying — useful when rotating subscriptions or
    /// adjusting callback gas after a real-world fulfill.
    function setVrfConfig(VrfConfig calldata cfg) external onlyRole(GOVERNANCE_ROLE) {
        vrfConfig = cfg;
        emit VrfConfigUpdated(cfg.keyHash, cfg.subscriptionId, cfg.requestConfirmations, cfg.callbackGasLimit);
    }

    function _validatePolicy(Policy memory p) internal pure {
        if (p.commitWindow == 0 || p.revealWindow == 0) revert InvalidPolicy();
        if (p.appealWindow == 0) revert InvalidPolicy();
        if (p.appealFeeBps > BPS_DENOMINATOR) revert InvalidPolicy();
        if (p.perArbiterFeeBps > BPS_DENOMINATOR) revert InvalidPolicy();
        if (p.treasury == address(0)) revert InvalidPolicy();
    }

    // ============================================================
    // Governance
    // ============================================================

    function registerArbiter(address arbiter, bytes32 credentialCID)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        if (arbiter == address(0)) revert ZeroAddress();
        Arbiter storage a = arbiters[arbiter];
        if (a.active) revert AlreadyActive();

        a.active = true;
        a.credentialCID = credentialCID;
        a.listIndex = uint64(_arbiterList.length);
        _arbiterList.push(arbiter);

        emit ArbiterRegistered(arbiter, credentialCID);
    }

    function revokeArbiter(address arbiter) external onlyRole(GOVERNANCE_ROLE) {
        Arbiter storage a = arbiters[arbiter];
        if (!a.active) revert NotActive();

        uint256 slashed = a.stakedAmount;
        a.stakedAmount = 0;
        a.active = false;

        if (slashed > 0) {
            treasuryAccrued[address(stakeToken)] += slashed;
        }

        // Swap-pop removal from arbiterList.
        uint64 idx = a.listIndex;
        uint256 last = _arbiterList.length - 1;
        if (uint256(idx) != last) {
            address moved = _arbiterList[last];
            _arbiterList[idx] = moved;
            arbiters[moved].listIndex = idx;
        }
        _arbiterList.pop();

        emit ArbiterRevoked(arbiter, slashed);
    }

    function setPolicy(Policy calldata p) external onlyRole(GOVERNANCE_ROLE) {
        _validatePolicy(p);
        policy = p;
        emit PolicyUpdated(
            p.commitWindow,
            p.revealWindow,
            p.graceWindow,
            p.appealWindow,
            p.repeatArbiterCooldown,
            p.stakeRequirement,
            p.appealFeeBps,
            p.perArbiterFeeBps,
            p.treasury
        );
    }

    function setNewCasesPaused(bool paused) external onlyRole(GOVERNANCE_ROLE) {
        newCasesPaused = paused;
        emit NewCasesPaused(paused);
    }

    function withdrawTreasury(IERC20 token, address to, uint256 amount)
        external
        onlyRole(GOVERNANCE_ROLE)
        nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = treasuryAccrued[address(token)];
        if (amount > bal) revert InsufficientTreasury();
        treasuryAccrued[address(token)] = bal - amount;
        token.safeTransfer(to, amount);
        emit TreasuryWithdrawn(address(token), to, amount);
    }

    // ============================================================
    // Arbiter staking (self-service)
    // ============================================================

    function stake(uint256 amount) external nonReentrant {
        Arbiter storage a = arbiters[msg.sender];
        if (!a.active) revert NotActive();
        if (amount == 0) revert AmountTooLarge();

        // CEI: bump state before the external transfer. The whole tx reverts
        // on a failed transfer, so the bumped state never lands without
        // matching tokens having moved.
        uint96 newTotal = a.stakedAmount + uint96(amount);
        a.stakedAmount = newTotal;
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        emit StakeIncreased(msg.sender, amount, newTotal);
    }

    function unstake(uint256 amount) external nonReentrant {
        Arbiter storage a = arbiters[msg.sender];
        if (a.stakedAmount < amount) revert InsufficientStake();
        // Cannot drop below the locked-on-active-panels portion. This keeps
        // the timeout slash punitive: a panelist who tries to dodge by
        // unstaking is rejected.
        uint96 newTotal = a.stakedAmount - uint96(amount);
        if (newTotal < lockedStake[msg.sender]) revert StakeLocked();

        // CEI: state first, transfer last.
        a.stakedAmount = newTotal;
        stakeToken.safeTransfer(msg.sender, amount);

        emit StakeWithdrawn(msg.sender, amount, newTotal);
    }

    // ============================================================
    // Case lifecycle (Phase 2 stubs — implemented in Phase 3+)
    //
    // All case-handling functions revert NotImplemented(). The new
    // single-arbiter + appeal-quorum-of-3 design is specified in
    // docs/arbitration-redesign.md. Phase 3 implements the original
    // arbiter happy path; Phase 4 implements the appeal flow.
    // ============================================================

    /// @notice Step 1 of two-phase case opening. Records the case in
    /// `AwaitingArbiter` state and requests randomness from the VRF
    /// coordinator. Arbiter selection happens later in the VRF callback.
    /// Returns the Aegis caseId — the keeper indexes the case immediately
    /// even though the arbiter won't be drawn until fulfillment lands.
    function openDispute(IArbitrableEscrow escrow, bytes32 escrowCaseId)
        external
        nonReentrant
        returns (bytes32 caseId)
    {
        if (newCasesPaused) revert CasePaused();
        if (address(escrow) == address(0)) revert ZeroAddress();

        if (liveCaseFor[address(escrow)][escrowCaseId] != bytes32(0)) {
            revert CaseAlreadyLive();
        }

        (
            address partyA,
            address partyB,
            address feeToken,
            uint256 amount,
            bool active
        ) = escrow.getDisputeContext(escrowCaseId);
        if (!active) revert EscrowReportsInactive();
        if (partyA == address(0) || partyB == address(0)) revert ZeroAddress();
        if (feeToken == address(0)) revert ZeroAddress();

        unchecked { ++_caseNonce; }
        caseId = keccak256(abi.encode(address(escrow), escrowCaseId, _caseNonce));
        if (_cases[caseId].state != CaseState.None) revert CaseExists();
        liveCaseFor[address(escrow)][escrowCaseId] = caseId;

        // Fail fast: if the eligible pool can't seat one arbiter, don't
        // pay VRF gas for a request that fulfillRandomWords would revert on.
        address[] memory noExclude;
        if (_eligibleArbiterCount(partyA, partyB, noExclude) == 0) {
            revert NotEnoughArbiters();
        }

        Case storage c = _cases[caseId];
        c.escrow = address(escrow);
        c.escrowCaseId = escrowCaseId;
        c.partyA = partyA;
        c.partyB = partyB;
        c.feeToken = feeToken;
        c.amount = amount;
        c.openedAt = uint64(block.timestamp);
        c.state = CaseState.AwaitingArbiter;

        VrfConfig memory cfg = vrfConfig;
        uint256 requestId = IVRFCoordinator(vrfCoordinator).requestRandomWords(
            cfg.keyHash,
            cfg.subscriptionId,
            cfg.requestConfirmations,
            cfg.callbackGasLimit,
            1
        );
        requestToCase[requestId] = caseId;

        emit CaseRequested(
            caseId, address(escrow), escrowCaseId,
            partyA, partyB, feeToken, amount, requestId
        );
        emit CaseOpened(
            caseId, address(escrow), escrowCaseId,
            partyA, partyB, feeToken, amount
        );
    }

    /// @notice VRF callback. Routes by case state — original-arbiter
    /// draw on `AwaitingArbiter`, appeal-arbiter draw on
    /// `AwaitingAppealPanel`. Both paths reuse `_drawArbiter` /
    /// `_drawTwoArbiters` from the sortition section.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords)
        internal
        override
    {
        bytes32 caseId = requestToCase[requestId];
        if (caseId == bytes32(0)) revert UnknownVrfRequest();
        delete requestToCase[requestId];

        Case storage c = _cases[caseId];

        if (c.state == CaseState.AwaitingArbiter) {
            _drawOriginal(c, caseId, randomWords[0]);
            return;
        }

        if (c.state == CaseState.AwaitingAppealPanel) {
            _drawAppealPanel(c, caseId, randomWords[0]);
            return;
        }

        revert CaseNotAwaitingPanel();
    }

    /// @dev Draw 2 appeal arbiters via VRF, excluding the original.
    /// Each gets stakeRequirement locked, caseCount bumped, and the
    /// D13 cooldown timestamp set. Sets the appeal commit + reveal
    /// deadlines. State → Voting (same name as the original phase
    /// per de novo review). Emits one ArbiterDrawn per slot.
    function _drawAppealPanel(Case storage c, bytes32 caseId, uint256 seed) internal {
        (address first, address second) = _drawTwoArbiters(
            seed, c.partyA, c.partyB, c.originalArbiter
        );

        Policy memory p = policy;
        bytes32 pairKey = _partyPairKey(c.partyA, c.partyB);
        uint64 nowTs = uint64(block.timestamp);

        arbiters[first].caseCount += 1;
        arbiters[second].caseCount += 1;
        lockedStake[first] += uint96(p.stakeRequirement);
        lockedStake[second] += uint96(p.stakeRequirement);
        lastArbitratedAt[pairKey][first] = nowTs;
        lastArbitratedAt[pairKey][second] = nowTs;

        c.appealSlots[0].arbiter = first;
        c.appealSlots[1].arbiter = second;
        c.appealCommitDeadline = nowTs + p.commitWindow;
        c.appealRevealDeadline = nowTs + p.commitWindow + p.revealWindow;
        c.state = CaseState.Voting;

        emit ArbiterDrawn(caseId, first);
        emit ArbiterDrawn(caseId, second);
    }

    /// @dev Draw the original arbiter, lock stake, set deadlines,
    /// transition to Voting. Used by both initial fulfill (round 0)
    /// and stall-redraw (round 1, future). On a redraw, the prior
    /// arbiter is excluded from the eligible pool.
    function _drawOriginal(Case storage c, bytes32 caseId, uint256 seed) internal {
        address[] memory exclude;
        if (c.originalArbiter != address(0)) {
            exclude = new address[](1);
            exclude[0] = c.originalArbiter;
        }

        address drawn = _drawArbiter(seed, c.partyA, c.partyB, exclude);

        Policy memory p = policy;
        arbiters[drawn].caseCount += 1;
        lockedStake[drawn] += uint96(p.stakeRequirement);
        lastArbitratedAt[_partyPairKey(c.partyA, c.partyB)][drawn] = uint64(block.timestamp);

        c.originalArbiter = drawn;
        c.originalCommitHash = bytes32(0);
        c.originalRevealed = false;
        c.originalCommitDeadline = uint64(block.timestamp + p.commitWindow);
        c.originalRevealDeadline = uint64(block.timestamp + p.commitWindow + p.revealWindow);
        c.state = CaseState.Voting;

        emit ArbiterDrawn(caseId, drawn);
    }

    function recuse(bytes32 /*caseId*/) external nonReentrant {
        revert NotImplemented();
    }

    /// @notice Submit the keccak commitment for this arbiter's vote.
    /// Routes by sender — the assigned original arbiter or an appeal-
    /// slot arbiter (Phase 4). Same external signature for both phases
    /// per de novo review (the arbiter's UI doesn't reveal which slot
    /// they're filling).
    function commitVote(bytes32 caseId, bytes32 commitHash) external {
        Case storage c = _cases[caseId];
        if (c.state != CaseState.Voting) revert CaseNotInVotingState();

        if (msg.sender == c.originalArbiter && !c.originalRevealed) {
            if (block.timestamp >= c.originalCommitDeadline) revert CommitWindowClosed();
            if (c.originalCommitHash != bytes32(0)) revert AlreadyCommitted();
            c.originalCommitHash = commitHash;
            emit Committed(caseId, msg.sender, commitHash);
            return;
        }

        uint8 slotIdx = _findAppealSlotIndex(c, msg.sender);
        if (slotIdx == type(uint8).max) revert NotAssignedArbiter();
        if (block.timestamp >= c.appealCommitDeadline) revert CommitWindowClosed();
        AppealSlot storage slot = c.appealSlots[slotIdx];
        if (slot.commitHash != bytes32(0)) revert AlreadyCommitted();
        slot.commitHash = commitHash;
        emit Committed(caseId, msg.sender, commitHash);
    }

    /// @notice Reveal the vote that was previously committed. The
    /// keccak hash recomputed from the revealed values must match
    /// the stored commit. Original-arbiter reveals immediately
    /// transition the case to AppealableResolved (no peers to wait
    /// for); appeal-slot reveals (Phase 4) wait for both peers.
    function revealVote(
        bytes32 caseId,
        uint16 partyAPercentage,
        bytes32 salt,
        bytes32 rationaleDigest
    ) external {
        Case storage c = _cases[caseId];
        if (c.state != CaseState.Voting) revert CaseNotInVotingState();
        if (partyAPercentage > 100) revert InvalidPercentage();

        if (msg.sender == c.originalArbiter && !c.originalRevealed) {
            if (block.timestamp < c.originalCommitDeadline) revert CommitWindowOpen();
            if (block.timestamp >= c.originalRevealDeadline) revert RevealWindowClosed();
            if (c.originalCommitHash == bytes32(0)) revert NoCommit();

            bytes32 expected = keccak256(abi.encode(
                msg.sender, caseId, partyAPercentage, salt, rationaleDigest
            ));
            if (expected != c.originalCommitHash) revert CommitMismatch();

            c.originalPercentage = partyAPercentage;
            c.originalDigest = rationaleDigest;
            c.originalRevealed = true;
            c.state = CaseState.AppealableResolved;
            c.appealDeadline = uint64(block.timestamp + policy.appealWindow);

            emit Revealed(caseId, msg.sender, partyAPercentage, rationaleDigest);
            return;
        }

        uint8 slotIdx = _findAppealSlotIndex(c, msg.sender);
        if (slotIdx == type(uint8).max) revert NotAssignedArbiter();
        if (block.timestamp < c.appealCommitDeadline) revert CommitWindowOpen();
        if (block.timestamp >= c.appealRevealDeadline) revert RevealWindowClosed();

        AppealSlot storage slot = c.appealSlots[slotIdx];
        if (slot.commitHash == bytes32(0)) revert NoCommit();
        if (slot.revealed) revert AlreadyRevealed();

        bytes32 expectedAppeal = keccak256(abi.encode(
            msg.sender, caseId, partyAPercentage, salt, rationaleDigest
        ));
        if (expectedAppeal != slot.commitHash) revert CommitMismatch();

        slot.partyAPercentage = partyAPercentage;
        slot.rationaleDigest = rationaleDigest;
        slot.revealed = true;

        emit Revealed(caseId, msg.sender, partyAPercentage, rationaleDigest);
        // State stays Voting; finalize() computes median once both
        // reveal or the reveal window closes.
    }

    /// @dev Returns 0 or 1 if `arbiter` fills that appeal slot, else
    /// type(uint8).max as a not-found sentinel. Cheap — only 2 slots.
    function _findAppealSlotIndex(Case storage c, address arbiter) internal view returns (uint8) {
        if (c.appealSlots[0].arbiter == arbiter) return 0;
        if (c.appealSlots[1].arbiter == arbiter) return 1;
        return type(uint8).max;
    }

    /// @notice Push a resolved case to the underlying escrow, capture
    /// the arbitration fee, and distribute it. Anyone can call —
    /// finalization is permissionless. Routes by case state:
    ///
    /// - AppealableResolved + appeal window expired ⇒ no-appeal settle
    ///   (this chunk).
    /// - Voting + reveal deadline passed ⇒ stall fallback (Phase 5).
    /// - AwaitingAppealPanel + VRF stuck (operational guard) (Phase 5).
    /// - Voting (appeal phase) + reveal deadline passed ⇒ appeal
    ///   settle (Phase 4).
    function finalize(bytes32 caseId) external nonReentrant {
        Case storage c = _cases[caseId];

        if (c.state == CaseState.AppealableResolved) {
            if (block.timestamp < c.appealDeadline) revert AppealWindowOpen();
            _settleNoAppeal(c, caseId);
            return;
        }

        if (c.state == CaseState.Voting && c.originalRevealed) {
            // Appeal phase: settle when both have revealed early, or
            // when the reveal window has closed (partial / full fail).
            bool bothRevealed = c.appealSlots[0].revealed && c.appealSlots[1].revealed;
            if (!bothRevealed && block.timestamp < c.appealRevealDeadline) {
                revert RevealWindowOpen();
            }
            _settleAppeal(c, caseId);
            return;
        }

        if (c.state == CaseState.Resolved || c.state == CaseState.Defaulted) {
            revert CaseAlreadyFinalized();
        }

        if (c.state == CaseState.None) {
            revert CaseNotFound();
        }

        revert NotImplemented(); // Phase 5: stall fallbacks
    }

    /// @dev Appeal happy / partial / full-fail path. Computes the
    /// final percentage from whatever votes are available, applies
    /// to escrow, captures fee, distributes the 7.5% pot
    /// (escrow fee + appellant's held appeal fee), slashes any
    /// non-revealing appeal arbiter, and refunds the appellant on E4.
    ///
    /// Cases:
    /// - Both reveal: median of 3 (D1 default).
    /// - One reveal: median of 2 (E3 per D5(a)). Failed slot's bond
    ///   is slashed; pot's unspent slot is rebated to parties pro-rata.
    /// - No reveals: original verdict applies (E4 per D3 confirm).
    ///   Both bonds slashed; appellant refunded their appeal fee.
    function _settleAppeal(Case storage c, bytes32 caseId) internal {
        AppealSlot storage slotA = c.appealSlots[0];
        AppealSlot storage slotB = c.appealSlots[1];
        bool aRevealed = slotA.revealed;
        bool bRevealed = slotB.revealed;

        uint16 finalPercentage;
        if (aRevealed && bRevealed) {
            finalPercentage = _medianOf3(
                c.originalPercentage,
                slotA.partyAPercentage,
                slotB.partyAPercentage
            );
        } else if (aRevealed || bRevealed) {
            uint16 appealVote = aRevealed ? slotA.partyAPercentage : slotB.partyAPercentage;
            finalPercentage = _medianOf2(c.originalPercentage, appealVote);
        } else {
            // E4: no appeal arbiter revealed; original verdict stands.
            finalPercentage = c.originalPercentage;
        }
        bytes32 finalDigest = c.originalDigest;
        address feeToken = c.feeToken;

        // Apply verdict to escrow, capture fee.
        uint256 balBefore = IERC20(feeToken).balanceOf(address(this));
        IArbitrableEscrow(c.escrow).applyArbitration(caseId, finalPercentage, finalDigest);
        uint256 balAfter = IERC20(feeToken).balanceOf(address(this));
        uint256 received = balAfter - balBefore;
        c.escrowFeeReceived = received;

        Policy memory p = policy;
        uint96 stake = uint96(p.stakeRequirement);

        // Release / slash arbiter locks.
        _releaseLock(c.originalArbiter, stake);
        if (aRevealed) {
            _releaseLock(slotA.arbiter, stake);
        } else {
            _slashArbiter(slotA.arbiter, stake, caseId);
        }
        if (bRevealed) {
            _releaseLock(slotB.arbiter, stake);
        } else {
            _slashArbiter(slotB.arbiter, stake, caseId);
        }

        // Pot to distribute = escrow fee + appellant's held appeal fee.
        uint256 totalPot = received + c.appealFeeAmount;
        uint256 perArbiter = (c.amount * p.perArbiterFeeBps) / BPS_DENOMINATOR;
        uint256 paidToArbiters = 0;

        // Original arbiter: always paid (their reveal happened in the
        // original phase, by definition of being in this branch).
        if (perArbiter > 0 && perArbiter <= totalPot) {
            claimable[c.originalArbiter][feeToken] += perArbiter;
            paidToArbiters += perArbiter;
        }
        if (aRevealed && paidToArbiters + perArbiter <= totalPot) {
            claimable[slotA.arbiter][feeToken] += perArbiter;
            paidToArbiters += perArbiter;
        }
        if (bRevealed && paidToArbiters + perArbiter <= totalPot) {
            claimable[slotB.arbiter][feeToken] += perArbiter;
            paidToArbiters += perArbiter;
        }

        // E4 (D3i*): refund the appellant's appeal fee from the
        // remaining pot before any party rebate.
        uint256 appellantRefund = 0;
        if (!aRevealed && !bRevealed && c.appealFeeAmount > 0 && c.appellant != address(0)) {
            appellantRefund = c.appealFeeAmount;
            claimable[c.appellant][feeToken] += appellantRefund;
        }

        // Remainder: party rebate pro-rata by verdict (D1(c) pattern,
        // extended to the appeal pot under D5(iv)-by-extension).
        uint256 remainder = totalPot - paidToArbiters - appellantRefund;
        if (remainder > 0) {
            uint256 partyAShare = (remainder * finalPercentage) / 100;
            uint256 partyBShare = remainder - partyAShare;
            if (partyAShare > 0) {
                claimable[c.partyA][feeToken] += partyAShare;
                emit PartyRebated(caseId, c.partyA, feeToken, partyAShare);
            }
            if (partyBShare > 0) {
                claimable[c.partyB][feeToken] += partyBShare;
                emit PartyRebated(caseId, c.partyB, feeToken, partyBShare);
            }
        }

        emit FeesAccrued(caseId, feeToken, totalPot, paidToArbiters, remainder, 0);
        c.feesDistributed = true;

        delete liveCaseFor[c.escrow][c.escrowCaseId];
        c.state = CaseState.Resolved;

        emit CaseResolved(caseId, finalPercentage, finalDigest);
    }

    /// @dev Median of 3 unsigned 16-bit values via three compare-swaps.
    function _medianOf3(uint16 a, uint16 b, uint16 c) internal pure returns (uint16) {
        if (a > b) (a, b) = (b, a);
        if (b > c) (b, c) = (c, b);
        if (a > b) (a, b) = (b, a);
        return b;
    }

    /// @dev Median of 2 = floor((a+b)/2) per D6.
    function _medianOf2(uint16 a, uint16 b) internal pure returns (uint16) {
        return uint16((uint256(a) + uint256(b)) / 2);
    }

    /// @dev Release `amount` from the arbiter's stake lock without
    /// touching their stakedAmount. Used on the success path.
    function _releaseLock(address arbiter, uint96 amount) internal {
        uint96 cur = lockedStake[arbiter];
        lockedStake[arbiter] = cur > amount ? cur - amount : 0;
    }

    /// @dev Slash `amount` ELCP from the arbiter's stakedAmount and
    /// release their lock for this case. Slashed amount → treasury in
    /// the stake token. Used on non-reveal paths.
    function _slashArbiter(address arbiter, uint256 amount, bytes32 caseId) internal {
        Arbiter storage a = arbiters[arbiter];
        uint96 slash = uint96(amount);
        if (slash > a.stakedAmount) slash = a.stakedAmount;
        a.stakedAmount -= slash;

        uint96 cur = lockedStake[arbiter];
        uint96 release = uint96(amount);
        lockedStake[arbiter] = cur > release ? cur - release : 0;

        if (slash > 0) {
            treasuryAccrued[address(stakeToken)] += slash;
            emit Slashed(arbiter, slash, caseId);
        }
    }

    /// @dev No-appeal happy path. Apply the original arbiter's verdict
    /// to the escrow, capture the arbitration fee via balance delta,
    /// release the arbiter's stake lock, distribute per D1(c):
    /// 2.5% to the arbiter + 2.5% rebated to parties proportional to
    /// the verdict. Then clear liveCaseFor and transition to Resolved.
    function _settleNoAppeal(Case storage c, bytes32 caseId) internal {
        uint16 percentage = c.originalPercentage;
        bytes32 digest = c.originalDigest;
        address feeToken = c.feeToken;
        address arbiter = c.originalArbiter;

        // External call: apply verdict, escrow pays our fee.
        uint256 balBefore = IERC20(feeToken).balanceOf(address(this));
        IArbitrableEscrow(c.escrow).applyArbitration(caseId, percentage, digest);
        uint256 balAfter = IERC20(feeToken).balanceOf(address(this));
        uint256 received = balAfter - balBefore;
        c.escrowFeeReceived = received;

        // Release the original arbiter's stake lock.
        uint96 release = uint96(policy.stakeRequirement);
        uint96 cur = lockedStake[arbiter];
        lockedStake[arbiter] = cur > release ? cur - release : 0;

        // Distribute the 5% pot per D1(c): half to arbiter,
        // half rebated to parties pro-rata by verdict.
        if (received > 0) {
            uint256 arbiterShare = received / 2;
            uint256 rebatePool = received - arbiterShare;

            claimable[arbiter][feeToken] += arbiterShare;

            uint256 partyAShare = (rebatePool * percentage) / 100;
            uint256 partyBShare = rebatePool - partyAShare;

            if (partyAShare > 0) {
                claimable[c.partyA][feeToken] += partyAShare;
                emit PartyRebated(caseId, c.partyA, feeToken, partyAShare);
            }
            if (partyBShare > 0) {
                claimable[c.partyB][feeToken] += partyBShare;
                emit PartyRebated(caseId, c.partyB, feeToken, partyBShare);
            }

            emit FeesAccrued(caseId, feeToken, received, arbiterShare, rebatePool, 0);
            c.feesDistributed = true;
        }

        // Clear the active-case marker so a future dispute on the same
        // escrow / escrowCaseId can be opened.
        delete liveCaseFor[c.escrow][c.escrowCaseId];
        c.state = CaseState.Resolved;

        emit CaseResolved(caseId, percentage, digest);
    }

    /// @notice File an appeal of the original arbiter's verdict.
    ///
    /// Eligibility rules (D12): only the loser of a full verdict can
    /// appeal. On a compromise verdict (percentage in [1, 99]), either
    /// party can appeal — they didn't get full satisfaction. On a full
    /// verdict (0 or 100), only the losing party can appeal.
    ///
    /// The appellant pays an appeal fee of `policy.appealFeeBps` of
    /// the disputed amount, denominated in the escrow's fee token
    /// (not ELCP — bonds are out under the new design). The fee is
    /// held in this contract until the appeal resolves; on partial-
    /// reveal failure paths it may be refunded.
    function requestAppeal(bytes32 caseId) external nonReentrant {
        Case storage c = _cases[caseId];
        if (c.state != CaseState.AppealableResolved) revert CaseNotAppealable();
        if (block.timestamp >= c.appealDeadline) revert AppealWindowClosed();
        if (msg.sender != c.partyA && msg.sender != c.partyB) revert AppealantNotParty();
        if (c.appellant != address(0)) revert AppealAlreadyExists();

        // D12: full winners cannot appeal.
        if (c.originalPercentage == 100 && msg.sender == c.partyA) revert FullWinnerCannotAppeal();
        if (c.originalPercentage == 0 && msg.sender == c.partyB) revert FullWinnerCannotAppeal();

        // Fail fast if we can't seat 2 appeal arbiters excluding the original.
        address[] memory exclude = new address[](1);
        exclude[0] = c.originalArbiter;
        if (_eligibleArbiterCount(c.partyA, c.partyB, exclude) < 2) {
            revert NotEnoughArbiters();
        }

        // Pull the appeal fee in the escrow's fee token. Held by Aegis
        // until distribution at appeal-finalize time.
        Policy memory p = policy;
        uint256 feeAmount = (c.amount * p.appealFeeBps) / BPS_DENOMINATOR;
        if (feeAmount > 0) {
            IERC20(c.feeToken).safeTransferFrom(msg.sender, address(this), feeAmount);
        }

        c.appellant = msg.sender;
        c.appealFeeAmount = feeAmount;
        c.state = CaseState.AwaitingAppealPanel;

        VrfConfig memory cfg = vrfConfig;
        uint256 requestId = IVRFCoordinator(vrfCoordinator).requestRandomWords(
            cfg.keyHash,
            cfg.subscriptionId,
            cfg.requestConfirmations,
            cfg.callbackGasLimit,
            1
        );
        requestToCase[requestId] = caseId;

        emit AppealRequested(caseId, msg.sender, feeAmount, c.feeToken, requestId);
    }

    // ============================================================
    // Internal: arbiter sortition + eligibility
    //
    // Eligibility = active + sufficient free stake + not a party +
    // not in the per-case exclude list + outside the D13 90-day
    // cooldown for the (partyA, partyB) pair.
    //
    // The cooldown applies symmetrically (canonical-ordered key): if
    // arbiter X arbitrated a case between (Alice, Bob) less than 90
    // days ago, X is ineligible for any new (Alice, Bob) or
    // (Bob, Alice) case. The exclusion does NOT extend to other
    // pairs, e.g. (Alice, Charlie).
    // ============================================================

    function _isEligible(
        address candidate,
        address partyA,
        address partyB,
        uint256 stakeRequirement,
        address[] memory exclude,
        bytes32 pairKey,
        uint64 cooldownStart
    ) internal view returns (bool) {
        if (candidate == partyA || candidate == partyB) return false;
        Arbiter storage a = arbiters[candidate];
        if (!a.active) return false;
        uint96 free = a.stakedAmount > lockedStake[candidate]
            ? a.stakedAmount - lockedStake[candidate]
            : 0;
        if (free < stakeRequirement) return false;
        if (_contains(exclude, candidate)) return false;
        if (lastArbitratedAt[pairKey][candidate] > cooldownStart) return false;
        return true;
    }

    function _contains(address[] memory arr, address target) internal pure returns (bool) {
        for (uint256 i = 0; i < arr.length; ++i) {
            if (arr[i] == target) return true;
        }
        return false;
    }

    /// @notice Count eligible arbiters. Used by openDispute /
    /// requestAppeal to fail-fast before paying VRF gas.
    function _eligibleArbiterCount(
        address partyA,
        address partyB,
        address[] memory exclude
    ) internal view returns (uint256 n) {
        Policy memory p = policy;
        bytes32 pairKey = _partyPairKey(partyA, partyB);
        uint64 cooldownStart = block.timestamp > p.repeatArbiterCooldown
            ? uint64(block.timestamp - p.repeatArbiterCooldown)
            : 0;
        uint256 listLen = _arbiterList.length;
        for (uint256 i = 0; i < listLen; ++i) {
            if (_isEligible(
                _arbiterList[i], partyA, partyB,
                p.stakeRequirement, exclude, pairKey, cooldownStart
            )) {
                ++n;
            }
        }
    }

    /// @notice Draw a single arbiter pseudorandomly from the eligible
    /// pool using a caller-supplied seed (typically a VRF word).
    /// Reverts `NotEnoughArbiters` if the pool is empty after
    /// applying the exclude list and the cooldown.
    function _drawArbiter(
        uint256 seed,
        address partyA,
        address partyB,
        address[] memory exclude
    ) internal view returns (address) {
        Policy memory p = policy;
        bytes32 pairKey = _partyPairKey(partyA, partyB);
        uint64 cooldownStart = block.timestamp > p.repeatArbiterCooldown
            ? uint64(block.timestamp - p.repeatArbiterCooldown)
            : 0;
        uint256 listLen = _arbiterList.length;
        address[] memory eligible = new address[](listLen);
        uint256 n = 0;
        for (uint256 i = 0; i < listLen; ++i) {
            address candidate = _arbiterList[i];
            if (_isEligible(
                candidate, partyA, partyB,
                p.stakeRequirement, exclude, pairKey, cooldownStart
            )) {
                eligible[n++] = candidate;
            }
        }
        if (n == 0) revert NotEnoughArbiters();
        return eligible[seed % n];
    }

    /// @notice Draw two distinct arbiters for the appeal phase,
    /// excluding the original arbiter. The second draw uses a derived
    /// seed (keccak of the original seed + first draw) so we only
    /// need a single VRF word per appeal.
    function _drawTwoArbiters(
        uint256 seed,
        address partyA,
        address partyB,
        address originalArbiter
    ) internal view returns (address first, address second) {
        address[] memory exclude1 = new address[](1);
        exclude1[0] = originalArbiter;
        first = _drawArbiter(seed, partyA, partyB, exclude1);

        address[] memory exclude2 = new address[](2);
        exclude2[0] = originalArbiter;
        exclude2[1] = first;

        uint256 seed2 = uint256(keccak256(abi.encode(seed, first)));
        second = _drawArbiter(seed2, partyA, partyB, exclude2);
    }

    // ============================================================
    // Pull-claim arbiter fees
    // ============================================================

    function claim(address token) external nonReentrant {
        uint256 amount = claimable[msg.sender][token];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit FeesClaimed(msg.sender, token, amount);
    }

    // ============================================================
    // View helpers (Phase 2.3 rewrites getCase / getCommit against
    // the new Case struct)
    // ============================================================

    function getCase(bytes32 /*caseId*/) external pure returns (bool) {
        revert NotImplemented();
    }

    function getCommit(bytes32 /*caseId*/, address /*arbiter*/)
        external
        pure
        returns (bool)
    {
        revert NotImplemented();
    }

    /// @notice Compute the commit-reveal hash off-chain. Must match what
    /// the on-chain reveal verifies. Same shape for original and appeal
    /// arbiters — the arbiter address differentiates.
    function hashVote(
        address arbiter,
        bytes32 caseId,
        uint16 partyAPercentage,
        bytes32 salt,
        bytes32 rationaleDigest
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(arbiter, caseId, partyAPercentage, salt, rationaleDigest));
    }
}
