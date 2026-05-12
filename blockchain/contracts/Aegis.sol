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

    /// @notice Cap on per-arbiter fee bps (H-01 audit fix). Anything
    /// over this could leave arbiters silently unpaid because the
    /// pot can't satisfy the per-arbiter requirement; cap to keep
    /// total arbiter pay (per-arbiter × 3) well within 7.5% of the
    /// disputed amount.
    uint16 public constant MAX_PER_ARBITER_FEE_BPS = 1000; // 10%
    /// @notice Cap on appeal fee bps (H-01). Same reasoning.
    uint16 public constant MAX_APPEAL_FEE_BPS = 1000; // 10%

    /// @notice Lower / upper bounds on policy windows (L-03). Defense
    /// in depth against governance setting unusable values.
    uint64 public constant MIN_COMMIT_REVEAL_WINDOW = 1 hours;
    uint64 public constant MAX_COMMIT_REVEAL_WINDOW = 30 days;
    uint64 public constant MIN_APPEAL_WINDOW = 1 days;
    uint64 public constant MAX_APPEAL_WINDOW = 30 days;
    uint64 public constant MAX_REPEAT_COOLDOWN = 5 * 365 days;

    /// @notice Hard cap on `_arbiterList.length` (M-03). Keeps the
    /// O(N) iteration in `_eligibleArbiterCount` / `_drawArbiter`
    /// bounded so VRF callbacks don't run out of gas.
    uint256 public constant MAX_ARBITER_ROSTER = 500;

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
        Defaulted, // 50/50 fallback applied after stall round 1
        Canceled // governance escape — VRF stuck (H-02 audit fix)
    }

    /// @notice How long a case must sit in AwaitingArbiter or
    /// AwaitingAppealPanel before governance can force-cancel it via
    /// `forceCancelStuck`. Defense against a single VRF outage
    /// permanently bricking cases (H-02 audit fix).
    uint64 public constant STUCK_CASE_GRACE = 30 days;

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
        address indexed treasury
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

    /// @notice Governance force-canceled a case stuck in AwaitingArbiter
    /// or AwaitingAppealPanel for longer than STUCK_CASE_GRACE. The
    /// underlying escrow is NOT settled — its own escape valve handles
    /// fund release. Held appeal fee (if any) is refunded.
    event CaseCanceled(bytes32 indexed caseId, uint256 appealFeeRefunded);
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
    error RosterFull();
    error LockUnderflow();
    error CaseNotStuck();
    error CaseNotYetStuck();
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
        // Window bounds (L-03): defense in depth against governance
        // setting unusable values (e.g. 1-second commit window).
        if (p.commitWindow < MIN_COMMIT_REVEAL_WINDOW || p.commitWindow > MAX_COMMIT_REVEAL_WINDOW) {
            revert InvalidPolicy();
        }
        if (p.revealWindow < MIN_COMMIT_REVEAL_WINDOW || p.revealWindow > MAX_COMMIT_REVEAL_WINDOW) {
            revert InvalidPolicy();
        }
        if (p.appealWindow < MIN_APPEAL_WINDOW || p.appealWindow > MAX_APPEAL_WINDOW) {
            revert InvalidPolicy();
        }
        if (p.repeatArbiterCooldown > MAX_REPEAT_COOLDOWN) revert InvalidPolicy();

        // Fee bps caps (H-01): keep arbiter pay bounded so the pot
        // distribution invariant (paidToArbiters ≤ totalPot) is
        // structurally satisfied even under extreme policy values.
        if (p.appealFeeBps > MAX_APPEAL_FEE_BPS) revert InvalidPolicy();
        if (p.perArbiterFeeBps > MAX_PER_ARBITER_FEE_BPS) revert InvalidPolicy();

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
        // M-03: cap roster size so VRF callback gas stays bounded.
        // Governance can revoke + register to rotate seats.
        if (_arbiterList.length >= MAX_ARBITER_ROSTER) revert RosterFull();
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

    /// @notice Force-cancel a case stuck in `AwaitingArbiter` or
    /// `AwaitingAppealPanel` for longer than STUCK_CASE_GRACE. Used
    /// only when Chainlink VRF has failed to fulfill (LINK depleted,
    /// coordinator outage, etc.). H-02 audit fix.
    ///
    /// Behavior:
    ///   - Refunds any held appeal fee back to the appellant.
    ///   - Clears `liveCaseFor` so the underlying escrow can reopen.
    ///   - Transitions to `Canceled` (terminal). Does NOT call
    ///     `applyArbitration` — the underlying escrow handles fund
    ///     release via its own escape valve (e.g. Vaultra DAO rescue).
    ///
    /// No stake locks are held in these states (VRF callback is what
    /// would lock them), so no release logic needed.
    function forceCancelStuck(bytes32 caseId)
        external
        onlyRole(GOVERNANCE_ROLE)
        nonReentrant
    {
        Case storage c = _cases[caseId];
        if (c.state != CaseState.AwaitingArbiter && c.state != CaseState.AwaitingAppealPanel) {
            revert CaseNotStuck();
        }
        if (block.timestamp < c.openedAt + STUCK_CASE_GRACE) revert CaseNotYetStuck();

        // Refund the appellant's held appeal fee, if any. (Only set
        // when state == AwaitingAppealPanel.)
        uint256 refunded = 0;
        if (c.appealFeeAmount > 0 && c.appellant != address(0)) {
            refunded = c.appealFeeAmount;
            claimable[c.appellant][c.feeToken] += refunded;
            c.appealFeeAmount = 0;
        }

        delete liveCaseFor[c.escrow][c.escrowCaseId];
        c.state = CaseState.Canceled;

        emit CaseCanceled(caseId, refunded);
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
        address[] memory noExclude = new address[](0);
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
        address[] memory exclude = new address[](0);
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

    /// @notice Voluntarily step down from a case before committing.
    /// Releases the arbiter's stake lock without slashing (they did
    /// nothing wrong) and synchronously draws a replacement using a
    /// prevrandao-derived seed. Allowed only during the commit phase
    /// and only if the arbiter hasn't yet committed — once committed,
    /// stepping down would let them dodge slashing.
    ///
    /// Synchronous redraw via prevrandao is acceptable because the
    /// recuser has no a-priori preference over which replacement is
    /// drawn (they're leaving voluntarily; the replacement is random
    /// from the eligible pool).
    function recuse(bytes32 caseId) external nonReentrant {
        Case storage c = _cases[caseId];
        if (c.state != CaseState.Voting) revert CaseNotInVotingState();

        address recuser = msg.sender;
        Policy memory p = policy;
        uint96 stakeAmt = uint96(p.stakeRequirement);

        // Original-slot recusal.
        if (recuser == c.originalArbiter && !c.originalRevealed) {
            if (block.timestamp >= c.originalCommitDeadline) revert CommitWindowClosed();
            if (c.originalCommitHash != bytes32(0)) revert CannotRecuseAfterCommit();

            _releaseLock(recuser, stakeAmt);

            address[] memory exclude = new address[](1);
            exclude[0] = recuser;
            uint256 seed = uint256(keccak256(abi.encode(block.prevrandao, caseId, recuser)));
            address replacement = _drawArbiter(seed, c.partyA, c.partyB, exclude);

            arbiters[replacement].caseCount += 1;
            lockedStake[replacement] += stakeAmt;
            lastArbitratedAt[_partyPairKey(c.partyA, c.partyB)][replacement] = uint64(block.timestamp);
            c.originalArbiter = replacement;

            emit Recused(caseId, recuser, replacement);
            emit ArbiterRedrawn(caseId, recuser, replacement);
            return;
        }

        // Appeal-slot recusal.
        uint8 slotIdx = _findAppealSlotIndex(c, recuser);
        if (slotIdx == type(uint8).max) revert NotAssignedArbiter();
        if (block.timestamp >= c.appealCommitDeadline) revert CommitWindowClosed();

        AppealSlot storage slot = c.appealSlots[slotIdx];
        if (slot.commitHash != bytes32(0)) revert CannotRecuseAfterCommit();

        _releaseLock(recuser, stakeAmt);

        address[] memory exc = new address[](3);
        exc[0] = c.originalArbiter;
        exc[1] = c.appealSlots[1 - slotIdx].arbiter;
        exc[2] = recuser;

        uint256 seed2 = uint256(keccak256(abi.encode(block.prevrandao, caseId, recuser)));
        address replacement2 = _drawArbiter(seed2, c.partyA, c.partyB, exc);

        arbiters[replacement2].caseCount += 1;
        lockedStake[replacement2] += stakeAmt;
        lastArbitratedAt[_partyPairKey(c.partyA, c.partyB)][replacement2] = uint64(block.timestamp);
        slot.arbiter = replacement2;

        emit Recused(caseId, recuser, replacement2);
        emit ArbiterRedrawn(caseId, recuser, replacement2);
    }

    /// @notice Submit the keccak commitment for this arbiter's vote.
    /// Routes by sender — the assigned original arbiter or an appeal-
    /// slot arbiter. Same external signature for both phases per de
    /// novo review (the arbiter's UI doesn't reveal which slot
    /// they're filling).
    ///
    /// nonReentrant is defense-in-depth (M-02): blocks an unusual
    /// re-entry path where a malicious escrow's `applyArbitration`
    /// callback (during finalize) would try to commitVote on behalf
    /// of itself. Wouldn't succeed anyway since the escrow isn't an
    /// assigned arbiter, but the guard makes the property explicit.
    function commitVote(bytes32 caseId, bytes32 commitHash) external nonReentrant {
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
    ) external nonReentrant {
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

        if (c.state == CaseState.Voting) {
            if (c.originalRevealed) {
                // Appeal phase: settle when both reveal or window closes.
                bool bothRevealed = c.appealSlots[0].revealed && c.appealSlots[1].revealed;
                if (!bothRevealed && block.timestamp < c.appealRevealDeadline) {
                    revert RevealWindowOpen();
                }
                _settleAppeal(c, caseId);
                return;
            }

            // Original phase stall: arbiter failed to reveal in time.
            if (block.timestamp < c.originalRevealDeadline) revert RevealWindowOpen();
            _stallOriginal(c, caseId);
            return;
        }

        if (
            c.state == CaseState.Resolved ||
            c.state == CaseState.Defaulted ||
            c.state == CaseState.Canceled
        ) {
            revert CaseAlreadyFinalized();
        }

        if (c.state == CaseState.None) {
            revert CaseNotFound();
        }

        // AwaitingArbiter / AwaitingAppealPanel: VRF hasn't fulfilled.
        // Operational issue, not a state-machine path. Governance
        // remediation lives outside finalize.
        revert CaseNotAwaitingPanel();
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
        IArbitrableEscrow(c.escrow).applyArbitration(c.escrowCaseId, finalPercentage, finalDigest);
        uint256 balAfter = IERC20(feeToken).balanceOf(address(this));
        uint256 received = balAfter - balBefore;
        c.escrowFeeReceived = received;

        Policy memory p = policy;
        uint96 stakeAmt = uint96(p.stakeRequirement);

        // Release / slash arbiter locks.
        _releaseLock(c.originalArbiter, stakeAmt);
        if (aRevealed) {
            _releaseLock(slotA.arbiter, stakeAmt);
        } else {
            _slashArbiter(slotA.arbiter, stakeAmt, caseId);
        }
        if (bRevealed) {
            _releaseLock(slotB.arbiter, stakeAmt);
        } else {
            _slashArbiter(slotB.arbiter, stakeAmt, caseId);
        }

        // Pot to distribute = escrow fee + appellant's held appeal fee.
        uint256 totalPot = received + c.appealFeeAmount;

        // M-01 fix: pre-compute how many arbiters get paid, then split
        // either at the policy target rate (if the pot can satisfy
        // everyone equally) or pro-rata (if it can't). Original is
        // always counted — their reveal happened in the original phase
        // by definition of being in this branch.
        uint256 payableCount = 1;
        if (aRevealed) ++payableCount;
        if (bRevealed) ++payableCount;

        // Cap check uses ceil(c.amount * perArbiterFeeBps / BPS) so the
        // wei-scale rounding of the floor division never flips this into
        // the wrong branch. Overflow bound: perArbiterFeeBps ≤ BPS so
        // perArbiterCeil ≤ c.amount, and payableCount ≤ 3, so the
        // subsequent multiplication is bounded by 3 * c.amount —
        // ~333× more headroom than the original c.amount * perArbiterFeeBps
        // intermediate (which itself overflows only past c.amount ≈ 10^74).
        // The share assignment keeps the floor so totalPayout never
        // exceeds totalPot.
        uint256 numerator = c.amount * p.perArbiterFeeBps;
        // OZ-standard overflow-safe ceil-div: subtract-then-add avoids the
        // narrow revert window the (n + d - 1)/d form has near uint256 max.
        uint256 perArbiterCeil = numerator == 0
            ? 0
            : (numerator - 1) / BPS_DENOMINATOR + 1;
        uint256 perArbiterShare;
        // slither-disable-next-line divide-before-multiply
        if (perArbiterCeil * payableCount <= totalPot) {
            perArbiterShare = numerator / BPS_DENOMINATOR;
        } else {
            // Pot too small for the policy target — split equally among
            // payable arbiters. Everyone gets the same reduced share;
            // no first-come-first-served starvation.
            perArbiterShare = totalPot / payableCount;
        }

        uint256 paidToArbiters = 0;
        if (perArbiterShare > 0) {
            claimable[c.originalArbiter][feeToken] += perArbiterShare;
            paidToArbiters += perArbiterShare;
            if (aRevealed) {
                claimable[slotA.arbiter][feeToken] += perArbiterShare;
                paidToArbiters += perArbiterShare;
            }
            if (bRevealed) {
                claimable[slotB.arbiter][feeToken] += perArbiterShare;
                paidToArbiters += perArbiterShare;
            }
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

    /// @dev Original arbiter failed to reveal by the deadline.
    /// Round 0 stall: slash the arbiter, request fresh VRF for a new
    /// draw (excluding the failed one). Round 1 stall: apply 50/50
    /// default verdict and transition to Defaulted (system can't
    /// produce a verdict; deterministic fallback).
    function _stallOriginal(Case storage c, bytes32 caseId) internal {
        Policy memory p = policy;

        // Slash and capture the actual amount taken (L-04 — may be less
        // than stakeRequirement if the arbiter was already slashed
        // elsewhere). Use the returned value in the Stalled event so
        // indexers see the real treasury delta.
        uint96 slashed = _slashArbiter(c.originalArbiter, p.stakeRequirement, caseId);

        if (c.stallRound == 0) {
            c.stallRound = 1;
            c.state = CaseState.AwaitingArbiter;
            // Reset commit state for the redraw. Keep originalArbiter
            // populated so _drawOriginal's redraw exclusion sees it.
            c.originalCommitHash = bytes32(0);

            VrfConfig memory cfg = vrfConfig;
            uint256 requestId = IVRFCoordinator(vrfCoordinator).requestRandomWords(
                cfg.keyHash,
                cfg.subscriptionId,
                cfg.requestConfirmations,
                cfg.callbackGasLimit,
                1
            );
            requestToCase[requestId] = caseId;

            emit Stalled(caseId, 0, slashed);
            return;
        }

        // Round 1 stall → 50/50 default verdict.
        emit Stalled(caseId, 1, slashed);
        _applyDefault(c, caseId);
    }

    /// @dev Apply DEFAULT_PERCENTAGE (50) to the escrow on a full
    /// stall. Entire escrow fee rebates to parties 50/50, matching
    /// the default verdict — no arbiter served, so the arbiter share
    /// is zero. Treasury keeps nothing on this path.
    function _applyDefault(Case storage c, bytes32 caseId) internal {
        address feeToken = c.feeToken;

        uint256 balBefore = IERC20(feeToken).balanceOf(address(this));
        IArbitrableEscrow(c.escrow).applyArbitration(c.escrowCaseId, DEFAULT_PERCENTAGE, bytes32(0));
        uint256 balAfter = IERC20(feeToken).balanceOf(address(this));
        uint256 received = balAfter - balBefore;
        c.escrowFeeReceived = received;

        if (received > 0) {
            uint256 partyAShare = received / 2;
            uint256 partyBShare = received - partyAShare;
            if (partyAShare > 0) {
                claimable[c.partyA][feeToken] += partyAShare;
                emit PartyRebated(caseId, c.partyA, feeToken, partyAShare);
            }
            if (partyBShare > 0) {
                claimable[c.partyB][feeToken] += partyBShare;
                emit PartyRebated(caseId, c.partyB, feeToken, partyBShare);
            }
            emit FeesAccrued(caseId, feeToken, received, 0, received, 0);
            c.feesDistributed = true;
        }

        delete liveCaseFor[c.escrow][c.escrowCaseId];
        c.state = CaseState.Defaulted;

        emit CaseDefaultResolved(caseId, DEFAULT_PERCENTAGE);
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
    /// L-01: strict — reverts on accounting drift instead of silently
    /// snapping to zero, which would let the arbiter unstake bonded
    /// stake on a subsequent call.
    function _releaseLock(address arbiter, uint96 amount) internal {
        uint96 cur = lockedStake[arbiter];
        if (cur < amount) revert LockUnderflow();
        lockedStake[arbiter] = cur - amount;
    }

    /// @dev Slash `amount` ELCP from the arbiter's stakedAmount and
    /// release their lock for this case. Slashed amount → treasury in
    /// the stake token. Returns the actual slashed amount (may be
    /// less than `amount` if the arbiter was already partially
    /// slashed elsewhere — L-04).
    ///
    /// stakedAmount is capped at the arbiter's actual balance — if
    /// they were already partially slashed elsewhere we slash what's
    /// available without reverting. The lock release uses the strict
    /// _releaseLock helper (L-01) so accounting drift is loud.
    function _slashArbiter(address arbiter, uint256 amount, bytes32 caseId)
        internal
        returns (uint96 slashed)
    {
        Arbiter storage a = arbiters[arbiter];
        slashed = uint96(amount);
        if (slashed > a.stakedAmount) slashed = a.stakedAmount;
        a.stakedAmount -= slashed;

        _releaseLock(arbiter, uint96(amount));

        if (slashed > 0) {
            treasuryAccrued[address(stakeToken)] += slashed;
            emit Slashed(arbiter, slashed, caseId);
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
        IArbitrableEscrow(c.escrow).applyArbitration(c.escrowCaseId, percentage, digest);
        uint256 balAfter = IERC20(feeToken).balanceOf(address(this));
        uint256 received = balAfter - balBefore;
        c.escrowFeeReceived = received;

        // Release the original arbiter's stake lock (strict via L-01).
        _releaseLock(arbiter, uint96(policy.stakeRequirement));

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
    // View helpers
    // ============================================================

    /// @notice Flat view of a case. The de novo soft-anonymity property
    /// is enforced UI-side — the contract exposes everything since
    /// chain data is public anyway. Callers (UIs) decide what to surface.
    struct CaseView {
        address escrow;
        bytes32 escrowCaseId;
        address partyA;
        address partyB;
        address feeToken;
        uint256 amount;
        CaseState state;
        uint8 stallRound;
        uint64 openedAt;
        address originalArbiter;
        bytes32 originalCommitHash;
        uint16 originalPercentage;
        bytes32 originalDigest;
        uint64 originalCommitDeadline;
        uint64 originalRevealDeadline;
        bool originalRevealed;
        address appellant;
        uint64 appealDeadline;
        uint64 appealCommitDeadline;
        uint64 appealRevealDeadline;
        uint256 appealFeeAmount;
        uint256 escrowFeeReceived;
        bool feesDistributed;
    }

    function getCase(bytes32 caseId) external view returns (CaseView memory) {
        Case storage c = _cases[caseId];
        return CaseView({
            escrow: c.escrow,
            escrowCaseId: c.escrowCaseId,
            partyA: c.partyA,
            partyB: c.partyB,
            feeToken: c.feeToken,
            amount: c.amount,
            state: c.state,
            stallRound: c.stallRound,
            openedAt: c.openedAt,
            originalArbiter: c.originalArbiter,
            originalCommitHash: c.originalCommitHash,
            originalPercentage: c.originalPercentage,
            originalDigest: c.originalDigest,
            originalCommitDeadline: c.originalCommitDeadline,
            originalRevealDeadline: c.originalRevealDeadline,
            originalRevealed: c.originalRevealed,
            appellant: c.appellant,
            appealDeadline: c.appealDeadline,
            appealCommitDeadline: c.appealCommitDeadline,
            appealRevealDeadline: c.appealRevealDeadline,
            appealFeeAmount: c.appealFeeAmount,
            escrowFeeReceived: c.escrowFeeReceived,
            feesDistributed: c.feesDistributed
        });
    }

    /// @notice Read one of the two appeal slots. Returns the zero
    /// AppealSlot if the case isn't in the appeal phase yet.
    function getAppealSlot(bytes32 caseId, uint8 idx) external view returns (AppealSlot memory) {
        require(idx < 2, "idx out of range");
        return _cases[caseId].appealSlots[idx];
    }

    /// @notice Read an arbiter's per-case commit status. Routes by
    /// arbiter address to either the original slot or one of the two
    /// appeal slots. Returns a zero CommitView if the arbiter isn't
    /// assigned to this case.
    struct CommitView {
        bytes32 hash;
        bool revealed;
        uint16 partyAPercentage;
        bytes32 rationaleDigest;
    }

    function getCommit(bytes32 caseId, address arbiter)
        external
        view
        returns (CommitView memory)
    {
        Case storage c = _cases[caseId];
        if (arbiter == c.originalArbiter) {
            return CommitView({
                hash: c.originalCommitHash,
                revealed: c.originalRevealed,
                partyAPercentage: c.originalPercentage,
                rationaleDigest: c.originalDigest
            });
        }
        for (uint8 i = 0; i < 2; ++i) {
            AppealSlot storage s = c.appealSlots[i];
            if (arbiter == s.arbiter && s.arbiter != address(0)) {
                return CommitView({
                    hash: s.commitHash,
                    revealed: s.revealed,
                    partyAPercentage: s.partyAPercentage,
                    rationaleDigest: s.rationaleDigest
                });
            }
        }
        return CommitView({hash: bytes32(0), revealed: false, partyAPercentage: 0, rationaleDigest: bytes32(0)});
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
