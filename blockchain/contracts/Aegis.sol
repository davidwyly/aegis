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
        uint8 panelSize; // odd, 3..=7
        uint64 voteWindow; // commit phase length, seconds
        uint64 revealWindow; // reveal phase length, seconds
        uint64 graceWindow; // grace before slashing on stall, seconds
        uint256 stakeRequirement; // minimum stake to be eligible for panels
        uint16 panelFeeBps; // share of fee paid to revealing panelists
        address treasury; // recipient for non-panel share
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
    // ============================================================

    enum CaseStatus {
        None,
        AwaitingPanel, // VRF requested; waiting for fulfillRandomWords callback
        Open, // commit phase
        Revealing, // reveal phase
        Resolved,
        DefaultResolved // 50/50 fallback applied after second stall
    }

    struct Commit {
        bytes32 hash;
        bool revealed;
        uint16 partyAPercentage;
        bytes32 rationaleDigest;
    }

    struct Case {
        address escrow;
        bytes32 escrowCaseId;
        address partyA;
        address partyB;
        address feeToken;
        uint256 amount;
        uint64 openedAt;
        uint64 deadlineCommit;
        uint64 deadlineReveal;
        uint8 round; // 0 first attempt, 1 redraw
        uint8 panelSize;
        uint8 commitCount;
        uint8 revealCount;
        CaseStatus status;
    }

    mapping(bytes32 => Case) private _cases;
    mapping(bytes32 => address[]) private _panels;
    mapping(bytes32 => mapping(address => Commit)) private _commits;

    /// @notice Currently-active Aegis case ID for a given
    /// (escrow, escrowCaseId) pair. Set on `openDispute`, cleared on
    /// resolve / default-resolve. Prevents two keepers from creating
    /// duplicate cases for the same underlying dispute.
    mapping(address => mapping(bytes32 => bytes32)) public liveCaseFor;

    /// @notice Pull-pattern fee balances. claimable[arbiter][token].
    mapping(address => mapping(address => uint256)) public claimable;

    /// @notice Treasury-accrued balances per token. Withdrawable by governance.
    mapping(address => uint256) public treasuryAccrued;

    uint256 private _caseNonce;

    // ============================================================
    // Events
    // ============================================================

    event ArbiterRegistered(address indexed arbiter, bytes32 credentialCID);
    event ArbiterRevoked(address indexed arbiter, uint256 slashedToTreasury);
    event StakeIncreased(address indexed arbiter, uint256 amount, uint256 newTotal);
    event StakeWithdrawn(address indexed arbiter, uint256 amount, uint256 newTotal);
    event PolicyUpdated(
        uint8 panelSize,
        uint64 voteWindow,
        uint64 revealWindow,
        uint64 graceWindow,
        uint256 stakeRequirement,
        uint16 panelFeeBps,
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
        uint256 amount,
        address[] panel
    );
    event VrfConfigUpdated(bytes32 keyHash, uint64 subscriptionId, uint16 confirmations, uint32 callbackGasLimit);
    event PanelRedrawn(bytes32 indexed caseId, address[] newPanel);
    event Recused(
        bytes32 indexed caseId,
        address indexed recused,
        address indexed replacement,
        uint8 seat
    );
    event Committed(bytes32 indexed caseId, address indexed panelist, bytes32 commitHash);
    event Revealed(
        bytes32 indexed caseId,
        address indexed panelist,
        uint16 partyAPercentage,
        bytes32 rationaleDigest
    );
    event PanelStalled(bytes32 indexed caseId, uint8 round, uint256 slashedTotal);
    event Slashed(address indexed arbiter, uint256 amount, bytes32 indexed caseId);
    event CaseResolved(
        bytes32 indexed caseId,
        uint16 medianPercentage,
        bytes32 finalDigest
    );
    event CaseDefaultResolved(bytes32 indexed caseId, uint16 fallbackPercentage);
    event FeesAccrued(
        bytes32 indexed caseId,
        address feeToken,
        uint256 totalReceived,
        uint256 panelTotal,
        uint256 treasuryAmount
    );
    event FeesClaimed(address indexed arbiter, address indexed token, uint256 amount);
    event TreasuryWithdrawn(address indexed token, address indexed to, uint256 amount);

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
    error StakeLocked();
    error CannotRecuseAfterCommit();
    error CaseAlreadyLive();
    error UnknownVrfRequest();
    error CaseNotAwaitingPanel();

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
        if (p.panelSize < 3 || p.panelSize > 7 || p.panelSize % 2 == 0) revert InvalidPolicy();
        if (p.voteWindow == 0 || p.revealWindow == 0) revert InvalidPolicy();
        if (p.panelFeeBps > BPS_DENOMINATOR) revert InvalidPolicy();
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
            p.panelSize,
            p.voteWindow,
            p.revealWindow,
            p.graceWindow,
            p.stakeRequirement,
            p.panelFeeBps,
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
    // Case lifecycle: open
    // ============================================================

    /// @notice Step 1 of two-phase case opening. Records the case in
    /// `AwaitingPanel` state and requests randomness from the VRF
    /// coordinator. Panel selection happens later in the VRF callback.
    /// Returns the Aegis caseId — the keeper indexes the case immediately
    /// even though the panel won't be drawn until fulfillment lands.
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

        unchecked {
            ++_caseNonce;
        }
        caseId = keccak256(abi.encode(address(escrow), escrowCaseId, _caseNonce));
        if (_cases[caseId].status != CaseStatus.None) revert CaseExists();
        liveCaseFor[address(escrow)][escrowCaseId] = caseId;

        Policy memory p = policy;

        // Fail fast if the eligible pool is too small. VRF requests cost
        // LINK / gas; we'd rather revert here than pay the request and
        // have fulfillRandomWords abort and leave the case stuck.
        address[] memory noExclude;
        if (
            _eligibleArbiterCount(partyA, partyB, p.stakeRequirement, noExclude) <
            p.panelSize
        ) revert NotEnoughArbiters();

        Case storage c = _cases[caseId];
        c.escrow = address(escrow);
        c.escrowCaseId = escrowCaseId;
        c.partyA = partyA;
        c.partyB = partyB;
        c.feeToken = feeToken;
        c.amount = amount;
        c.openedAt = uint64(block.timestamp);
        // Deadlines are set in fulfillRandomWords once the panel is
        // actually seated — they should run from when arbiters know
        // they're on the panel, not from when the request was made.
        c.round = 0;
        c.panelSize = p.panelSize;
        c.status = CaseStatus.AwaitingPanel;

        VrfConfig memory cfg = vrfConfig;
        uint256 requestId = IVRFCoordinator(vrfCoordinator).requestRandomWords(
            cfg.keyHash,
            cfg.subscriptionId,
            cfg.requestConfirmations,
            cfg.callbackGasLimit,
            1
        );
        requestToCase[requestId] = caseId;

        emit CaseRequested(caseId, address(escrow), escrowCaseId, partyA, partyB, feeToken, amount, requestId);
    }

    /// @notice VRF callback. Used by both initial open (round 0) and
    /// stall-redraw (round 1). The exclusion list comes from whatever
    /// addresses are currently in `_panels[caseId]` — empty on initial
    /// open, the old panel on redraw — so the same fulfilment path
    /// covers both flows.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        bytes32 caseId = requestToCase[requestId];
        if (caseId == bytes32(0)) revert UnknownVrfRequest();
        delete requestToCase[requestId];

        Case storage c = _cases[caseId];
        if (c.status != CaseStatus.AwaitingPanel) revert CaseNotAwaitingPanel();

        Policy memory p = policy;
        address[] memory exclude = _panels[caseId]; // empty on first request, old panel on redraw

        address[] memory panel = _drawPanelWithSeed(
            randomWords[0],
            c.partyA,
            c.partyB,
            p.panelSize,
            p.stakeRequirement,
            exclude
        );
        _panels[caseId] = panel;
        for (uint256 i = 0; i < panel.length; ++i) {
            arbiters[panel[i]].caseCount += 1;
            lockedStake[panel[i]] += uint96(p.stakeRequirement);
        }

        c.deadlineCommit = uint64(block.timestamp + p.voteWindow);
        c.deadlineReveal = uint64(block.timestamp + p.voteWindow + p.revealWindow);
        c.status = CaseStatus.Open;

        if (c.round == 0) {
            emit CaseOpened(
                caseId,
                c.escrow,
                c.escrowCaseId,
                c.partyA,
                c.partyB,
                c.feeToken,
                c.amount,
                panel
            );
        } else {
            emit PanelRedrawn(caseId, panel);
        }
    }

    // ============================================================
    // Case lifecycle: commit / reveal
    // ============================================================

    /**
     * @notice Recuse from a case before committing. Releases the panelist's
     *         stake-lock and draws a replacement panelist into their seat,
     *         using the same exclusion rules (no parties, no current panel).
     *         Allowed only during the commit phase and only if the panelist
     *         hasn't yet committed — once you've committed, you've already
     *         signalled you can rule, and exiting would let you dodge
     *         slashing.
     */
    function recuse(bytes32 caseId) external nonReentrant {
        Case storage c = _cases[caseId];
        if (c.status != CaseStatus.Open) revert CaseNotOpen();
        if (block.timestamp >= c.deadlineCommit) revert CommitWindowClosed();
        if (!_isPanelist(caseId, msg.sender)) revert NotPanelist();
        if (_commits[caseId][msg.sender].hash != bytes32(0)) {
            revert CannotRecuseAfterCommit();
        }

        // Release this panelist's lock.
        Policy memory p = policy;
        uint96 cur = lockedStake[msg.sender];
        uint96 release = uint96(p.stakeRequirement);
        lockedStake[msg.sender] = cur > release ? cur - release : 0;

        // Find the seat index.
        address[] storage panel = _panels[caseId];
        uint8 seatIdx = type(uint8).max;
        for (uint256 i = 0; i < panel.length; ++i) {
            if (panel[i] == msg.sender) {
                seatIdx = uint8(i);
                break;
            }
        }
        // Defensive — _isPanelist already ensured this.
        if (seatIdx == type(uint8).max) revert NotPanelist();

        // Build exclusion = the existing panel (which already includes the
        // recusing panelist, so they're naturally excluded from the redraw).
        address[] memory exclude = new address[](panel.length);
        for (uint256 i = 0; i < panel.length; ++i) {
            exclude[i] = panel[i];
        }

        // Recuse is panelist-initiated and not pre-targetable by an attacker;
        // a prevrandao-derived seed is acceptable here (vs. VRF for the main
        // case-open / stall-redraw paths). See _drawPanelWithSeed.
        uint256 recuseSeed = uint256(
            keccak256(abi.encode(block.prevrandao, caseId, msg.sender, block.timestamp))
        );
        address[] memory replacement = _drawPanelWithSeed(
            recuseSeed,
            c.partyA,
            c.partyB,
            1,
            p.stakeRequirement,
            exclude
        );

        panel[seatIdx] = replacement[0];
        arbiters[replacement[0]].caseCount += 1;
        lockedStake[replacement[0]] += uint96(p.stakeRequirement);

        emit Recused(caseId, msg.sender, replacement[0], seatIdx);
    }

    function commitVote(bytes32 caseId, bytes32 commitHash) external {
        Case storage c = _cases[caseId];
        if (c.status != CaseStatus.Open) revert CaseNotOpen();
        if (block.timestamp >= c.deadlineCommit) revert CommitWindowClosed();
        if (!_isPanelist(caseId, msg.sender)) revert NotPanelist();

        Commit storage cm = _commits[caseId][msg.sender];
        if (cm.hash != bytes32(0)) revert AlreadyCommitted();

        cm.hash = commitHash;
        c.commitCount += 1;

        emit Committed(caseId, msg.sender, commitHash);
    }

    function revealVote(
        bytes32 caseId,
        uint16 partyAPercentage,
        bytes32 salt,
        bytes32 rationaleDigest
    ) external {
        Case storage c = _cases[caseId];
        if (c.status != CaseStatus.Open && c.status != CaseStatus.Revealing) revert CaseNotRevealing();
        if (block.timestamp < c.deadlineCommit) revert CommitWindowOpen();
        if (block.timestamp >= c.deadlineReveal) revert RevealWindowClosed();
        if (partyAPercentage > 100) revert InvalidPercentage();
        if (!_isPanelist(caseId, msg.sender)) revert NotPanelist();

        // Auto-transition Open -> Revealing on first reveal of the phase.
        if (c.status == CaseStatus.Open) {
            c.status = CaseStatus.Revealing;
        }

        Commit storage cm = _commits[caseId][msg.sender];
        if (cm.hash == bytes32(0)) revert NoCommit();
        if (cm.revealed) revert AlreadyRevealed();

        bytes32 expected = keccak256(
            abi.encode(msg.sender, caseId, partyAPercentage, salt, rationaleDigest)
        );
        if (expected != cm.hash) revert CommitMismatch();

        cm.revealed = true;
        cm.partyAPercentage = partyAPercentage;
        cm.rationaleDigest = rationaleDigest;
        c.revealCount += 1;

        emit Revealed(caseId, msg.sender, partyAPercentage, rationaleDigest);
    }

    // ============================================================
    // Case lifecycle: finalize
    // ============================================================

    /**
     * @notice Finalize a case. Three terminal paths plus a "wait" path:
     *
     *   - All panelists revealed → resolve immediately by median.
     *   - Reveal window closed AND revealCount >= quorum → resolve by
     *     median.
     *   - Reveal window + grace closed AND revealCount < quorum →
     *     stall: round 0 slashes non-revealers and redraws once;
     *     round 1 falls back to a 50/50 default.
     *   - Otherwise revert — still in the active commit/reveal/grace
     *     window.
     *
     * Early resolution only when ALL panelists have revealed (not just
     * a quorum) prevents a colluding panelist from racing finalize to
     * lock in a favourable median before the third panelist reveals.
     */
    function finalize(bytes32 caseId) external nonReentrant {
        Case storage c = _cases[caseId];
        if (c.status == CaseStatus.None) revert CaseNotFound();
        if (c.status == CaseStatus.Resolved || c.status == CaseStatus.DefaultResolved) {
            revert CaseAlreadyFinalized();
        }

        uint8 quorum = (c.panelSize / 2) + 1;

        // All-revealed: fast path, resolves immediately.
        if (c.revealCount == c.panelSize) {
            _resolveByMedian(c, caseId, quorum);
            return;
        }

        // Anything below all-revealed has to wait for the reveal window.
        if (block.timestamp < c.deadlineReveal) revert RevealWindowOpen();

        if (c.revealCount >= quorum) {
            _resolveByMedian(c, caseId, quorum);
            return;
        }

        // Sub-quorum: also need the grace window before slashing.
        uint64 stallDeadline = c.deadlineReveal + policy.graceWindow;
        if (block.timestamp < stallDeadline) revert GraceWindowOpen();

        if (c.round == 0) {
            _stallAndRedraw(c, caseId);
        } else {
            _resolveDefault(c, caseId);
        }
    }

    function _releasePanelLocks(bytes32 caseId, uint256 stakeRequirement) internal {
        address[] memory panel = _panels[caseId];
        for (uint256 i = 0; i < panel.length; ++i) {
            uint96 cur = lockedStake[panel[i]];
            uint96 release = uint96(stakeRequirement);
            lockedStake[panel[i]] = cur > release ? cur - release : 0;
        }
    }

    function _resolveByMedian(Case storage c, bytes32 caseId, uint8 quorum) internal {
        address[] memory panel = _panels[caseId];
        uint16[] memory votes = new uint16[](c.revealCount);
        bytes32[] memory digests = new bytes32[](c.revealCount);
        address[] memory revealers = new address[](c.revealCount);
        uint256 idx;
        for (uint256 i = 0; i < panel.length; ++i) {
            Commit storage cm = _commits[caseId][panel[i]];
            if (cm.revealed) {
                votes[idx] = cm.partyAPercentage;
                digests[idx] = cm.rationaleDigest;
                revealers[idx] = panel[i];
                ++idx;
            }
        }

        uint16 median = _median(votes);
        bytes32 finalDigest = keccak256(abi.encode(caseId, votes, digests));

        c.status = CaseStatus.Resolved;

        // Settle on the underlying escrow. Measure fee delta to know how much
        // the escrow paid us.
        uint256 balBefore = IERC20(c.feeToken).balanceOf(address(this));
        IArbitrableEscrow(c.escrow).applyArbitration(c.escrowCaseId, median, finalDigest);
        uint256 balAfter = IERC20(c.feeToken).balanceOf(address(this));
        uint256 received = balAfter > balBefore ? balAfter - balBefore : 0;

        _distributeFees(caseId, c.feeToken, received, revealers);

        // Quorum is unused here today, but kept in the signature so the
        // function reads as "I confirmed enough reveals to resolve."
        quorum;

        _releasePanelLocks(caseId, policy.stakeRequirement);
        delete liveCaseFor[c.escrow][c.escrowCaseId];
        emit CaseResolved(caseId, median, finalDigest);
    }

    function _stallAndRedraw(Case storage c, bytes32 caseId) internal {
        uint256 slashedTotal = _slashNonRevealers(caseId);

        // Release locks for the old (now-departing) panel.
        Policy memory p = policy;
        _releasePanelLocks(caseId, p.stakeRequirement);

        // If the eligible pool (excluding the just-departed panel) is too
        // small to seat a fresh round, jump straight to default 50/50
        // rather than getting stuck waiting on a VRF fulfillment that
        // would revert. Stale-roster recovery vs. permanently-stuck case.
        address[] memory oldPanel = _panels[caseId];
        if (
            _eligibleArbiterCount(c.partyA, c.partyB, p.stakeRequirement, oldPanel) <
            c.panelSize
        ) {
            emit PanelStalled(caseId, 0, slashedTotal);
            _settleDefault(c, caseId);
            return;
        }

        // Reset commit/reveal state. The old panel addresses stay in
        // `_panels[caseId]` so fulfillRandomWords can use them as the
        // exclude list for the fresh draw — they get overwritten when
        // the new panel is seated.
        c.commitCount = 0;
        c.revealCount = 0;
        c.round = 1;
        c.status = CaseStatus.AwaitingPanel;

        // Request VRF for the new panel — same anti-manipulation
        // posture as the initial open.
        VrfConfig memory cfg = vrfConfig;
        uint256 requestId = IVRFCoordinator(vrfCoordinator).requestRandomWords(
            cfg.keyHash,
            cfg.subscriptionId,
            cfg.requestConfirmations,
            cfg.callbackGasLimit,
            1
        );
        requestToCase[requestId] = caseId;

        emit PanelStalled(caseId, 0, slashedTotal);
        // PanelRedrawn fires from fulfillRandomWords once the new panel is seated.
    }

    function _resolveDefault(Case storage c, bytes32 caseId) internal {
        uint256 slashedTotal = _slashNonRevealers(caseId);
        _releasePanelLocks(caseId, policy.stakeRequirement);
        emit PanelStalled(caseId, 1, slashedTotal);
        _settleDefault(c, caseId);
    }

    /// @notice 50/50 settlement primitive. Caller is responsible for any
    /// slashing + lock release that should happen first; this just
    /// applies the fallback verdict and clears live-case state. Used by
    /// both the round-1 stall path and the round-0 redraw-impossible path.
    function _settleDefault(Case storage c, bytes32 caseId) internal {
        c.status = CaseStatus.DefaultResolved;
        bytes32 finalDigest = keccak256(abi.encode(caseId, "DEFAULT_50_50"));

        uint256 balBefore = IERC20(c.feeToken).balanceOf(address(this));
        IArbitrableEscrow(c.escrow).applyArbitration(c.escrowCaseId, DEFAULT_PERCENTAGE, finalDigest);
        uint256 balAfter = IERC20(c.feeToken).balanceOf(address(this));
        uint256 received = balAfter > balBefore ? balAfter - balBefore : 0;

        if (received > 0) {
            treasuryAccrued[c.feeToken] += received;
            emit FeesAccrued(caseId, c.feeToken, received, 0, received);
        }

        delete liveCaseFor[c.escrow][c.escrowCaseId];
        emit CaseDefaultResolved(caseId, DEFAULT_PERCENTAGE);
    }

    function _slashNonRevealers(bytes32 caseId) internal returns (uint256 slashedTotal) {
        address[] memory panel = _panels[caseId];
        // Slash exactly the bond posted for THIS case (= stakeRequirement),
        // capped at the panelist's remaining stake. This:
        //   (a) makes non-reveal a full-bond loss — no partial-dodge math
        //       where a 50%-slash could still be profitable, and
        //   (b) doesn't punish arbiters who staked more than the minimum
        //       (the excess sits in their stake, not at risk per case).
        uint96 bond = uint96(policy.stakeRequirement);
        for (uint256 i = 0; i < panel.length; ++i) {
            address panelist = panel[i];
            Commit storage cm = _commits[caseId][panelist];
            if (cm.revealed) continue;

            Arbiter storage a = arbiters[panelist];
            if (a.stakedAmount == 0) continue;

            uint96 cut = bond > a.stakedAmount ? a.stakedAmount : bond;
            if (cut == 0) continue;

            a.stakedAmount -= cut;
            treasuryAccrued[address(stakeToken)] += cut;
            slashedTotal += cut;

            emit Slashed(panelist, cut, caseId);
        }
    }

    function _distributeFees(
        bytes32 caseId,
        address feeToken,
        uint256 received,
        address[] memory revealers
    ) internal {
        if (received == 0) {
            emit FeesAccrued(caseId, feeToken, 0, 0, 0);
            return;
        }

        uint256 panelTotal = (received * policy.panelFeeBps) / BPS_DENOMINATOR;
        uint256 treasuryAmount = received - panelTotal;

        if (revealers.length > 0 && panelTotal > 0) {
            uint256 perPanelist = panelTotal / revealers.length;
            uint256 distributed = perPanelist * revealers.length;
            for (uint256 i = 0; i < revealers.length; ++i) {
                claimable[revealers[i]][feeToken] += perPanelist;
            }
            // Donate any rounding dust to the treasury so balances stay exact.
            treasuryAmount += panelTotal - distributed;
        } else {
            // No revealers (shouldn't happen on the success path) — all to treasury.
            treasuryAmount = received;
        }

        treasuryAccrued[feeToken] += treasuryAmount;

        emit FeesAccrued(caseId, feeToken, received, panelTotal, treasuryAmount);
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
    // Panel selection (sortition by VRF random word, or recuse seed)
    // ============================================================

    /// @notice Count eligible arbiters with the same predicate the panel
    /// draw uses. Lets `openDispute` and `_stallAndRedraw` fail fast
    /// before paying VRF gas if the pool is too small.
    function _eligibleArbiterCount(
        address partyA,
        address partyB,
        uint256 stakeRequirement,
        address[] memory exclude
    ) internal view returns (uint256 n) {
        uint256 listLen = _arbiterList.length;
        for (uint256 i = 0; i < listLen; ++i) {
            address candidate = _arbiterList[i];
            if (candidate == partyA || candidate == partyB) continue;
            Arbiter storage a = arbiters[candidate];
            if (!a.active) continue;
            uint96 free = a.stakedAmount > lockedStake[candidate]
                ? a.stakedAmount - lockedStake[candidate]
                : 0;
            if (free < stakeRequirement) continue;
            if (_contains(exclude, candidate)) continue;
            ++n;
        }
    }

    /// @notice Draw a panel using a caller-supplied uint256 seed. VRF
    /// callback supplies a verifiably-random word; the synchronous
    /// recuse path supplies a prevrandao-derived seed (acceptable
    /// because the panelist who recuses has no a-priori preference
    /// over which replacement is drawn).
    function _drawPanelWithSeed(
        uint256 seed,
        address partyA,
        address partyB,
        uint8 panelSize,
        uint256 stakeRequirement,
        address[] memory exclude
    ) internal view returns (address[] memory panel) {
        // Build pool of eligible arbiters (active, sufficient stake, not party,
        // not in exclude list).
        uint256 listLen = _arbiterList.length;
        address[] memory pool = new address[](listLen);
        uint256 poolLen;

        for (uint256 i = 0; i < listLen; ++i) {
            address candidate = _arbiterList[i];
            if (candidate == partyA || candidate == partyB) continue;
            Arbiter storage a = arbiters[candidate];
            if (!a.active) continue;
            // Only count free stake — already-locked-on-other-cases stake
            // doesn't qualify, so an arbiter can't multi-book themselves
            // beyond what they've actually bonded.
            uint96 free = a.stakedAmount > lockedStake[candidate]
                ? a.stakedAmount - lockedStake[candidate]
                : 0;
            if (free < stakeRequirement) continue;
            if (_contains(exclude, candidate)) continue;
            pool[poolLen++] = candidate;
        }

        if (poolLen < panelSize) revert NotEnoughArbiters();

        // Fisher–Yates partial shuffle. `seed` is the caller's responsibility
        // — VRF callback passes the verifiable random word; recuse passes a
        // prevrandao-derived seed.
        panel = new address[](panelSize);
        for (uint256 i = 0; i < panelSize; ++i) {
            // pick j in [i, poolLen)
            uint256 j = i + (uint256(keccak256(abi.encode(seed, i))) % (poolLen - i));
            address tmp = pool[i];
            pool[i] = pool[j];
            pool[j] = tmp;
            panel[i] = pool[i];
        }
    }

    function _contains(address[] memory arr, address needle) internal pure returns (bool) {
        for (uint256 i = 0; i < arr.length; ++i) {
            if (arr[i] == needle) return true;
        }
        return false;
    }

    function _isPanelist(bytes32 caseId, address candidate) internal view returns (bool) {
        address[] storage panel = _panels[caseId];
        for (uint256 i = 0; i < panel.length; ++i) {
            if (panel[i] == candidate) return true;
        }
        return false;
    }

    // ============================================================
    // Median (sort small array in place)
    // ============================================================

    function _median(uint16[] memory values) internal pure returns (uint16) {
        uint256 n = values.length;
        // Insertion sort (n <= 7).
        for (uint256 i = 1; i < n; ++i) {
            uint16 key = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > key) {
                values[j] = values[j - 1];
                --j;
            }
            values[j] = key;
        }
        if (n == 0) return DEFAULT_PERCENTAGE;
        if (n % 2 == 1) return values[n / 2];
        // even count (e.g. 2 reveals on a 3-panel) → take lower middle for determinism
        return values[(n / 2) - 1];
    }

    // ============================================================
    // Views
    // ============================================================

    function getCase(bytes32 caseId)
        external
        view
        returns (
            address escrow,
            bytes32 escrowCaseId,
            address partyA,
            address partyB,
            address feeToken,
            uint256 amount,
            uint64 openedAt,
            uint64 deadlineCommit,
            uint64 deadlineReveal,
            uint8 round,
            uint8 panelSize,
            uint8 commitCount,
            uint8 revealCount,
            CaseStatus status
        )
    {
        Case storage c = _cases[caseId];
        return (
            c.escrow,
            c.escrowCaseId,
            c.partyA,
            c.partyB,
            c.feeToken,
            c.amount,
            c.openedAt,
            c.deadlineCommit,
            c.deadlineReveal,
            c.round,
            c.panelSize,
            c.commitCount,
            c.revealCount,
            c.status
        );
    }

    function getPanel(bytes32 caseId) external view returns (address[] memory) {
        return _panels[caseId];
    }

    function getCommit(bytes32 caseId, address panelist)
        external
        view
        returns (
            bytes32 hash,
            bool revealed,
            uint16 partyAPercentage,
            bytes32 rationaleDigest
        )
    {
        Commit storage cm = _commits[caseId][panelist];
        return (cm.hash, cm.revealed, cm.partyAPercentage, cm.rationaleDigest);
    }

    function arbiterCount() external view returns (uint256) {
        return _arbiterList.length;
    }

    function arbiterAt(uint256 index) external view returns (address) {
        return _arbiterList[index];
    }

    /**
     * @notice Hash a vote the way the contract expects for commit-reveal.
     *         Off-chain helpers should call this view to produce the hash
     *         that matches the on-chain check.
     */
    function hashVote(
        address panelist,
        bytes32 caseId,
        uint16 partyAPercentage,
        bytes32 salt,
        bytes32 rationaleDigest
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(panelist, caseId, partyAPercentage, salt, rationaleDigest));
    }
}
