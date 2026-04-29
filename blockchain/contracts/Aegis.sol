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
        Voting, // commit window open
        Revealing, // reveal window open
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

    function openDispute(IArbitrableEscrow /*escrow*/, bytes32 /*escrowCaseId*/)
        external
        nonReentrant
        returns (bytes32)
    {
        revert NotImplemented();
    }

    function fulfillRandomWords(uint256 /*requestId*/, uint256[] calldata /*randomWords*/)
        internal
        override
    {
        revert NotImplemented();
    }

    function recuse(bytes32 /*caseId*/) external nonReentrant {
        revert NotImplemented();
    }

    function commitVote(bytes32 /*caseId*/, bytes32 /*commitHash*/) external {
        revert NotImplemented();
    }

    function revealVote(
        bytes32 /*caseId*/,
        uint16 /*partyAPercentage*/,
        bytes32 /*salt*/,
        bytes32 /*rationaleDigest*/
    ) external {
        revert NotImplemented();
    }

    function finalize(bytes32 /*caseId*/) external nonReentrant {
        revert NotImplemented();
    }

    function requestAppeal(bytes32 /*caseId*/) external nonReentrant {
        revert NotImplemented();
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
