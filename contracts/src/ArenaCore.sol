// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AgentStatus, SessionState, Attestation, AttestationHash} from "./libs/Types.sol";
import {IAgentRegistry, IPolicyWallet, IScoreRegistry} from "./interfaces/IArena.sol";

/// @title ArenaCore
/// @notice Paid, time-boxed attack sessions. Breach payout is automatic (triggered by the agent's own
///         outflow through PolicyWallet.payBounty); survival credit requires a gateway attestation.
contract ArenaCore is EIP712 {
    using SafeERC20 for IERC20;

    struct Session {
        uint256 agentId;
        address attacker; // payout address (≠ owner, ≠ signer)
        address opener; // msg.sender who paid the fee
        uint8 tier; // 1..4
        uint128 lockedBounty;
        uint128 fee;
        uint64 openedAt;
        uint64 expiresAt;
        SessionState state;
        uint128 payout;
        uint32 msgCount;
        bytes32 transcriptRoot;
    }

    IERC20 public immutable usdc;
    IAgentRegistry public immutable registry;
    IScoreRegistry public score;
    address public grantPool;
    address public admin;
    address public gatewayAttestor;
    address public keeper;
    bool public wired;
    bool public paused;

    uint64 public sessionTTL = 30 minutes;
    uint64 public expiryGrace = 1 hours;
    uint32 public maxAttemptsPerDay = 5;
    uint16 public constant VAULT_FEE_BPS = 7000; // 70% of survived fees → bounty pool, 30% → GrantPool

    uint128[5] public tierBounty;
    uint128[5] public tierFee;

    uint256 public nextSessionId = 1;
    mapping(uint256 => Session) internal _sessions;
    mapping(uint256 => mapping(address => uint256)) internal _live; // agentId → attacker → sid
    mapping(uint256 => mapping(address => mapping(uint256 => uint32))) public attempts; // agent → attacker → day → n

    event SessionOpened(
        uint256 indexed sid,
        uint256 indexed agentId,
        address indexed attacker,
        address opener,
        uint8 tier,
        uint128 lockedBounty,
        uint128 fee,
        uint64 expiresAt
    );
    event Breach(uint256 indexed sid, uint256 indexed agentId, address indexed attacker, uint128 payout);
    event SessionSurvived(uint256 indexed sid, uint256 indexed agentId, uint32 msgCount, bytes32 transcriptRoot);
    event SessionExpired(uint256 indexed sid, uint256 indexed agentId);
    event FeeSplit(uint256 indexed sid, uint128 toVault, uint128 toGrantPool);
    event TierParamsUpdated(uint128[5] bounty, uint128[5] fee);

    error NotAdmin();
    error AlreadyWired();
    error Paused();
    error NotActive();
    error BadTier();
    error BadAttacker();
    error SessionLive();
    error TooManyAttempts();
    error NotVault();
    error NotOpen();
    error BadAttestation();
    error NotExpired();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        address usdc_,
        address registry_,
        address admin_,
        address attestor_,
        uint128[5] memory bounty_,
        uint128[5] memory fee_,
        uint64 ttl_
    ) EIP712("ArenaCore", "1") {
        usdc = IERC20(usdc_);
        registry = IAgentRegistry(registry_);
        admin = admin_;
        gatewayAttestor = attestor_;
        tierBounty = bounty_;
        tierFee = fee_;
        if (ttl_ != 0) sessionTTL = ttl_;
    }

    function wire(address score_, address grantPool_, address keeper_) external onlyAdmin {
        if (wired) revert AlreadyWired();
        wired = true;
        score = IScoreRegistry(score_);
        grantPool = grantPool_;
        keeper = keeper_;
    }

    // ───────────────────────────── admin (cannot move vault funds) ─────────────────────────────

    function setTierParams(uint128[5] calldata bounty_, uint128[5] calldata fee_) external onlyAdmin {
        tierBounty = bounty_;
        tierFee = fee_;
        emit TierParamsUpdated(bounty_, fee_);
    }

    function setSessionParams(uint64 ttl, uint64 grace, uint32 maxPerDay) external onlyAdmin {
        sessionTTL = ttl;
        expiryGrace = grace;
        maxAttemptsPerDay = maxPerDay;
    }

    function setPaused(bool p) external onlyAdmin {
        paused = p;
    }

    function setAttestor(address a) external onlyAdmin {
        gatewayAttestor = a;
    }

    function setKeeper(address k) external onlyAdmin {
        keeper = k;
    }

    // ───────────────────────────── sessions ─────────────────────────────

    function openSession(uint256 agentId, uint8 tier, address payout) external returns (uint256 sid) {
        if (paused) revert Paused();
        if (registry.statusOf(agentId) != AgentStatus.Active) revert NotActive();
        if (tier == 0 || tier > 4) revert BadTier();
        address owner = registry.ownerOf(agentId);
        address signer = registry.signerOf(agentId);
        if (
            payout == address(0) || payout == owner || payout == signer || msg.sender == owner
                || msg.sender == signer
        ) revert BadAttacker();
        if (liveSessionOf(agentId, payout) != 0) revert SessionLive();

        uint256 day = block.timestamp / 1 days;
        if (attempts[agentId][payout][day] >= maxAttemptsPerDay) revert TooManyAttempts();
        attempts[agentId][payout][day] += 1;

        uint128 fee = tierFee[tier];
        uint128 bounty = tierBounty[tier];
        if (fee > 0) usdc.safeTransferFrom(msg.sender, address(this), fee);
        IPolicyWallet(registry.vaultOf(agentId)).lock(bounty);

        sid = nextSessionId++;
        uint64 expiresAt = uint64(block.timestamp) + sessionTTL;
        Session storage s = _sessions[sid];
        s.agentId = agentId;
        s.attacker = payout;
        s.opener = msg.sender;
        s.tier = tier;
        s.lockedBounty = bounty;
        s.fee = fee;
        s.openedAt = uint64(block.timestamp);
        s.expiresAt = expiresAt;
        s.state = SessionState.Open;
        _live[agentId][payout] = sid;

        emit SessionOpened(sid, agentId, payout, msg.sender, tier, bounty, fee, expiresAt);
    }

    /// @notice Live session id for (agent, attacker), or 0. A session is live while Open and unexpired.
    function liveSessionOf(uint256 agentId, address attacker) public view returns (uint256) {
        uint256 sid = _live[agentId][attacker];
        if (sid == 0) return 0;
        Session storage s = _sessions[sid];
        if (s.state != SessionState.Open || block.timestamp > s.expiresAt) return 0;
        return sid;
    }

    /// @notice Called by the agent's vault when the agent pays the live attacker. Objective breach.
    function onBreach(uint256 sid, uint128 requested) external returns (uint128 payout, uint128 locked) {
        Session storage s = _sessions[sid];
        if (msg.sender != registry.vaultOf(s.agentId)) revert NotVault();
        if (s.state != SessionState.Open || block.timestamp > s.expiresAt) revert NotOpen();

        locked = s.lockedBounty;
        payout = requested < locked ? requested : locked;
        s.state = SessionState.Breached;
        s.payout = payout;
        delete _live[s.agentId][s.attacker];

        if (s.fee > 0) usdc.safeTransfer(s.attacker, s.fee); // fee refunded to the winner
        registry.setStatus(s.agentId, AgentStatus.Breached);
        score.onBreach(s.agentId, s.attacker, s.tier);
        emit Breach(sid, s.agentId, s.attacker, payout);
    }

    /// @notice Close a session the agent survived, using the gateway's signed attestation.
    function closeSession(Attestation calldata a, bytes calldata gatewaySig) external {
        Session storage s = _sessions[a.sid];
        if (s.state != SessionState.Open) revert NotOpen();
        bytes32 digest = _hashTypedDataV4(AttestationHash.hash(a));
        if (ECDSA.recover(digest, gatewaySig) != gatewayAttestor || a.endedAt > block.timestamp) {
            revert BadAttestation();
        }

        IPolicyWallet vault = IPolicyWallet(registry.vaultOf(s.agentId));
        delete _live[s.agentId][s.attacker];
        vault.unlock(s.lockedBounty);

        // A concurrent session already breached (or suspended) this agent: no survival credit is possible.
        if (registry.statusOf(s.agentId) != AgentStatus.Active) {
            s.state = SessionState.Expired;
            if (s.fee > 0) usdc.safeTransfer(s.opener, s.fee);
            emit SessionExpired(a.sid, s.agentId);
            return;
        }

        s.state = SessionState.Survived;
        s.msgCount = a.msgCount;
        s.transcriptRoot = a.transcriptRoot;

        uint128 toVault = uint128((uint256(s.fee) * VAULT_FEE_BPS) / 10_000);
        uint128 toGrant = s.fee - toVault;
        if (toVault > 0) {
            usdc.safeTransfer(address(vault), toVault);
            vault.creditBounty(toVault);
        }
        if (toGrant > 0) usdc.safeTransfer(grantPool, toGrant);
        emit FeeSplit(a.sid, toVault, toGrant);

        score.credit(s.agentId, s.attacker, s.tier, a.msgCount);
        emit SessionSurvived(a.sid, s.agentId, a.msgCount, a.transcriptRoot);
    }

    /// @notice Permissionless cleanup when no attestation arrived. Refunds the fee, no score credit.
    function expireStale(uint256 sid) external {
        Session storage s = _sessions[sid];
        if (s.state != SessionState.Open) revert NotOpen();
        if (block.timestamp <= s.expiresAt + expiryGrace && msg.sender != keeper) revert NotExpired();
        if (block.timestamp <= s.expiresAt) revert NotExpired();
        s.state = SessionState.Expired;
        delete _live[s.agentId][s.attacker];
        IPolicyWallet(registry.vaultOf(s.agentId)).unlock(s.lockedBounty);
        if (s.fee > 0) usdc.safeTransfer(s.opener, s.fee);
        emit SessionExpired(sid, s.agentId);
    }

    // ───────────────────────────── views ─────────────────────────────

    function getSession(uint256 sid) external view returns (Session memory) {
        return _sessions[sid];
    }

    function tierBountyOf(uint8 tier) external view returns (uint128) {
        return tierBounty[tier];
    }

    function tierBounties() external view returns (uint128[5] memory) {
        return tierBounty;
    }

    function tierFees() external view returns (uint128[5] memory) {
        return tierFee;
    }

    function attestationDigest(Attestation calldata a) external view returns (bytes32) {
        return _hashTypedDataV4(AttestationHash.hash(a));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
