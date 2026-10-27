// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {AgentStatus, Policy, Intent, IntentHash} from "./libs/Types.sol";
import {RollingWindow} from "./libs/RollingWindow.sol";
import {MerkleLib} from "./libs/MerkleLib.sol";
import {IAgentRegistry, IArenaCore, IScoreRegistry} from "./interfaces/IArena.sol";

/// @title PolicyWallet
/// @notice Per-agent vault with two compartments:
///         - treasury:   production funds, gated by allowlist + per-tx cap + rolling limit (= proven bounty) + escalation
///         - bountyPool: at-risk funds, attackable during live arena sessions
///         The agent's authority is enforced here, not in its prompt.
contract PolicyWallet is EIP712 {
    using SafeERC20 for IERC20;
    using RollingWindow for RollingWindow.Buckets;

    IERC20 public usdc;
    IAgentRegistry public registry;
    IArenaCore public arena;
    IScoreRegistry public score;
    address public factory;
    uint256 public agentId;
    bool private _initialized;
    uint256 private _entered;

    Policy public policy;

    uint128 public treasury;
    uint128 public bountyPool;
    uint128 public lockedBounty;

    mapping(uint64 => bool) public usedNonce;
    RollingWindow.Buckets private _spent;

    event TreasuryDeposited(uint256 indexed agentId, address indexed from, uint128 amount);
    event BountyDeposited(uint256 indexed agentId, address indexed from, uint128 amount);
    event TreasuryWithdrawn(uint256 indexed agentId, address indexed to, uint128 amount);
    event BountyWithdrawn(uint256 indexed agentId, address indexed to, uint128 amount);
    event BountyCredited(uint256 indexed agentId, uint128 amount);
    event BountyLocked(uint256 indexed agentId, uint128 amount, uint128 totalLocked);
    event BountyUnlocked(uint256 indexed agentId, uint128 amount, uint128 totalLocked);
    event PolicyUpdated(uint256 indexed agentId, uint128 perTxCap, uint128 approvalThreshold, uint128 floorDailyLimit);
    event ProductionPayment(
        uint256 indexed agentId,
        address indexed to,
        uint128 amount,
        bytes32 category,
        bytes32 ref,
        bool escalated,
        uint64 nonce
    );
    event VendorPaidFromBounty(uint256 indexed agentId, address indexed to, uint128 amount, bytes32 ref, uint64 nonce);
    event BountyPaid(uint256 indexed agentId, uint256 indexed sid, address indexed to, uint128 payout);

    error AlreadyInitialized();
    error NotOwner();
    error NotSigner();
    error NotArena();
    error BadIntent();
    error NotActive();
    error NotAllowlisted();
    error PerTxCap();
    error EscalationRequired();
    error InsufficientFunds();
    error RecipientNotAllowed();
    error Reentrancy();
    error BadPolicy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != registry.ownerOf(agentId)) revert NotOwner();
        _;
    }

    modifier onlyArena() {
        if (msg.sender != address(arena)) revert NotArena();
        _;
    }

    constructor() EIP712("PolicyWallet", "1") {
        _initialized = true; // lock the implementation
    }

    function initialize(
        uint256 agentId_,
        address usdc_,
        address registry_,
        address arena_,
        address score_,
        Policy calldata policy_
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (policy_.windowSecs < 24 || policy_.approvalThreshold > policy_.perTxCap) revert BadPolicy();
        _initialized = true;
        factory = msg.sender;
        agentId = agentId_;
        usdc = IERC20(usdc_);
        registry = IAgentRegistry(registry_);
        arena = IArenaCore(arena_);
        score = IScoreRegistry(score_);
        policy = policy_;
    }

    // ───────────────────────────── funding ─────────────────────────────

    function depositTreasury(uint128 amt) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amt);
        treasury += amt;
        emit TreasuryDeposited(agentId, msg.sender, amt);
    }

    function depositBounty(uint128 amt) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amt);
        bountyPool += amt;
        emit BountyDeposited(agentId, msg.sender, amt);
    }

    /// @notice Arena routes 70% of survived-session fees into the bounty pool (already transferred).
    function creditBounty(uint128 amt) external onlyArena {
        bountyPool += amt;
        emit BountyCredited(agentId, amt);
    }

    function withdrawBounty(uint128 amt) external onlyOwner nonReentrant {
        if (amt > bountyPool - lockedBounty) revert InsufficientFunds();
        bountyPool -= amt;
        usdc.safeTransfer(msg.sender, amt);
        emit BountyWithdrawn(agentId, msg.sender, amt);
    }

    function withdrawTreasury(uint128 amt) external onlyOwner nonReentrant {
        if (amt > treasury) revert InsufficientFunds();
        treasury -= amt;
        usdc.safeTransfer(msg.sender, amt);
        emit TreasuryWithdrawn(agentId, msg.sender, amt);
    }

    /// @notice Owner may adjust caps; the window length is fixed at init.
    function setPolicy(uint128 perTxCap, uint128 approvalThreshold, uint128 floorDailyLimit) external onlyOwner {
        if (approvalThreshold > perTxCap) revert BadPolicy();
        policy.perTxCap = perTxCap;
        policy.approvalThreshold = approvalThreshold;
        policy.floorDailyLimit = floorDailyLimit;
        emit PolicyUpdated(agentId, perTxCap, approvalThreshold, floorDailyLimit);
    }

    // ───────────────────────────── arena hooks ─────────────────────────────

    function lock(uint128 amount) external onlyArena {
        if (bountyPool - lockedBounty < amount) revert InsufficientFunds();
        lockedBounty += amount;
        emit BountyLocked(agentId, amount, lockedBounty);
    }

    function unlock(uint128 amount) external onlyArena {
        lockedBounty -= amount;
        emit BountyUnlocked(agentId, amount, lockedBounty);
    }

    // ───────────────────────────── production path ─────────────────────────────

    /// @notice Autonomous vendor payment from treasury. Above-threshold or above-limit spend requires
    ///         an owner co-signature — escalation is never silent and never blocks.
    function payProduction(Intent calldata i, bytes32[] calldata proof, bytes calldata ownerSig)
        external
        nonReentrant
    {
        _checkIntent(i);
        AgentStatus st = registry.statusOf(agentId);
        if (st == AgentStatus.None) revert NotActive();
        if (!MerkleLib.verify(registry.allowlistRootOf(agentId), i.to, proof)) revert NotAllowlisted();
        Policy memory p = policy;
        if (i.amount > p.perTxCap) revert PerTxCap();
        if (i.amount > treasury) revert InsufficientFunds();

        uint128 limit = _dailyLimit(st, p);
        uint128 used = _spent.sum(block.timestamp, p.windowSecs);
        bool needsOwner = (i.amount > p.approvalThreshold) || (used + i.amount > limit);
        if (needsOwner) {
            if (
                ownerSig.length == 0
                    || !SignatureChecker.isValidSignatureNow(registry.ownerOf(agentId), hashIntent(i), ownerSig)
            ) revert EscalationRequired();
        }

        usedNonce[i.nonce] = true;
        _spent.add(block.timestamp, p.windowSecs, i.amount);
        treasury -= i.amount;
        usdc.safeTransfer(i.to, i.amount);
        emit ProductionPayment(agentId, i.to, i.amount, i.category, i.ref, needsOwner, i.nonce);
    }

    // ───────────────────────────── arena path (attack surface) ─────────────────────────────

    /// @notice Agent-initiated outflow from the bounty pool.
    ///         - allowlisted recipient: legitimate in-session vendor payment, capped.
    ///         - live-session attacker: this IS a breach — the contract pays the locked bounty automatically.
    ///         - anything else: reverts (no loss for drive-by recipients).
    function payBounty(Intent calldata i, bytes32[] calldata proof) external nonReentrant {
        _checkIntent(i);
        if (registry.statusOf(agentId) != AgentStatus.Active) revert NotActive();
        usedNonce[i.nonce] = true;

        if (MerkleLib.verify(registry.allowlistRootOf(agentId), i.to, proof)) {
            if (i.amount > bountyPool - lockedBounty || i.amount > policy.perTxCap) revert PerTxCap();
            bountyPool -= i.amount;
            usdc.safeTransfer(i.to, i.amount);
            emit VendorPaidFromBounty(agentId, i.to, i.amount, i.ref, i.nonce);
            return;
        }

        uint256 sid = arena.liveSessionOf(agentId, i.to);
        if (sid == 0) revert RecipientNotAllowed();
        (uint128 payout, uint128 locked) = arena.onBreach(sid, i.amount);
        bountyPool -= payout;
        lockedBounty -= locked;
        usdc.safeTransfer(i.to, payout);
        emit BountyPaid(agentId, sid, i.to, payout);
    }

    // ───────────────────────────── views ─────────────────────────────

    function hashIntent(Intent calldata i) public view returns (bytes32) {
        return _hashTypedDataV4(IntentHash.hash(i));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function freeBounty() external view returns (uint128) {
        return bountyPool - lockedBounty;
    }

    function spentInWindow() external view returns (uint128) {
        return _spent.sum(block.timestamp, policy.windowSecs);
    }

    function dailyLimit() external view returns (uint128) {
        return _dailyLimit(registry.statusOf(agentId), policy);
    }

    function _dailyLimit(AgentStatus st, Policy memory p) internal view returns (uint128) {
        if (st != AgentStatus.Active) return p.floorDailyLimit;
        uint128 proven = score.dailyLimit(agentId);
        return proven > p.floorDailyLimit ? proven : p.floorDailyLimit;
    }

    function _checkIntent(Intent calldata i) internal view {
        if (msg.sender != registry.signerOf(agentId)) revert NotSigner();
        if (i.agentId != agentId || usedNonce[i.nonce] || block.timestamp > i.deadline || i.amount == 0) {
            revert BadIntent();
        }
    }
}
