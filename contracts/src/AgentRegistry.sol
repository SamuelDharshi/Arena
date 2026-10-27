// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AgentStatus, Policy} from "./libs/Types.sol";
import {IScoreRegistry} from "./interfaces/IArena.sol";
import {PolicyWalletFactory} from "./PolicyWalletFactory.sol";

/// @title AgentRegistry
/// @notice Canonical registry of arena agents: owner, signer, vault, configHash, allowlist root and status.
contract AgentRegistry {
    struct Agent {
        address owner;
        address signer; // key that signs/submits payment intents
        address vault; // PolicyWallet clone
        bytes32 configHash; // keccak256(model ‖ prompt ‖ validators ‖ tools ‖ runtime)
        bytes32 mandateHash;
        bytes32 allowlistRoot; // Merkle root of approved counterparties
        uint64 registeredAt;
        uint64 configChangedAt;
        AgentStatus status;
        string endpoint; // AAP base URL
        string metadataURI; // name, description, mandate text
    }

    struct PendingRoot {
        bytes32 root;
        uint64 eta;
    }

    address public admin;
    address public pendingAdmin;
    PolicyWalletFactory public factory;
    IScoreRegistry public score;
    address public arena;
    address public exploits;
    address public keeper;
    bool public wired;

    uint64 public allowlistDelay = 1 hours;
    uint64 public breachCooldown; // time after a breach before the owner can patch & re-enter
    bool public allowInsecureEndpoints; // permit http:// endpoints (testnet / local dev)

    uint256 public agentCount;
    mapping(uint256 => Agent) internal _agents;
    mapping(address => uint256) public agentOfSigner;
    mapping(uint256 => PendingRoot) public pendingAllowlist;
    mapping(uint256 => uint64) public breachedAt;

    event AgentRegistered(
        uint256 indexed agentId, address indexed owner, address signer, address vault, bytes32 configHash
    );
    event ConfigUpdated(uint256 indexed agentId, bytes32 oldHash, bytes32 newHash);
    event AllowlistProposed(uint256 indexed agentId, bytes32 root, uint64 eta);
    event AllowlistUpdated(uint256 indexed agentId, bytes32 oldRoot, bytes32 newRoot);
    event EndpointUpdated(uint256 indexed agentId, string endpoint);
    event MetadataUpdated(uint256 indexed agentId, string metadataURI);
    event StatusChanged(uint256 indexed agentId, AgentStatus status);
    event DecisionAnchored(uint256 indexed agentId, bytes32 logHash, uint32 decisions);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotOwner();
    error NotSigner();
    error NotAuthorized();
    error AlreadyWired();
    error BadSigner();
    error BadEndpoint();
    error UnknownAgent();
    error Cooldown();
    error NotReady();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyAgentOwner(uint256 agentId) {
        if (_agents[agentId].owner != msg.sender) revert NotOwner();
        _;
    }

    constructor(address admin_, uint64 breachCooldown_, bool allowInsecureEndpoints_) {
        admin = admin_;
        breachCooldown = breachCooldown_;
        allowInsecureEndpoints = allowInsecureEndpoints_;
    }

    /// @notice One-time wiring of protocol contracts (prevents admin from later swapping the arena).
    function wire(address factory_, address score_, address arena_, address exploits_, address keeper_)
        external
        onlyAdmin
    {
        if (wired) revert AlreadyWired();
        wired = true;
        factory = PolicyWalletFactory(factory_);
        score = IScoreRegistry(score_);
        arena = arena_;
        exploits = exploits_;
        keeper = keeper_;
    }

    function setKeeper(address keeper_) external onlyAdmin {
        keeper = keeper_;
    }

    function setAllowInsecureEndpoints(bool v) external onlyAdmin {
        allowInsecureEndpoints = v;
    }

    function transferAdmin(address to) external onlyAdmin {
        pendingAdmin = to;
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAuthorized();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // ───────────────────────────── registration ─────────────────────────────

    function registerAgent(
        address signer,
        bytes32 configHash,
        bytes32 mandateHash,
        bytes32 allowlistRoot,
        string calldata endpoint,
        string calldata metadataURI,
        Policy calldata policy
    ) external returns (uint256 agentId) {
        if (signer == address(0) || signer == msg.sender || agentOfSigner[signer] != 0) revert BadSigner();
        _checkEndpoint(endpoint);

        agentId = ++agentCount;
        address vault = factory.deploy(agentId, policy);

        Agent storage a = _agents[agentId];
        a.owner = msg.sender;
        a.signer = signer;
        a.vault = vault;
        a.configHash = configHash;
        a.mandateHash = mandateHash;
        a.allowlistRoot = allowlistRoot;
        a.registeredAt = uint64(block.timestamp);
        a.configChangedAt = uint64(block.timestamp);
        a.status = AgentStatus.Active;
        a.endpoint = endpoint;
        a.metadataURI = metadataURI;
        agentOfSigner[signer] = agentId;

        emit AgentRegistered(agentId, msg.sender, signer, vault, configHash);
        emit StatusChanged(agentId, AgentStatus.Active);
    }

    /// @notice Patch & re-enter. Any config change resets the proven tier (score keeps 25%).
    function updateConfig(uint256 agentId, bytes32 newConfigHash) external onlyAgentOwner(agentId) {
        Agent storage a = _agents[agentId];
        if (a.status == AgentStatus.Breached && block.timestamp < breachedAt[agentId] + breachCooldown) {
            revert Cooldown();
        }
        bytes32 old = a.configHash;
        a.configHash = newConfigHash;
        a.configChangedAt = uint64(block.timestamp);
        if (a.status != AgentStatus.Active) {
            a.status = AgentStatus.Active;
            emit StatusChanged(agentId, AgentStatus.Active);
        }
        score.onConfigChange(agentId);
        emit ConfigUpdated(agentId, old, newConfigHash);
    }

    /// @notice Propose a new allowlist root; it activates after `allowlistDelay`.
    function updateAllowlist(uint256 agentId, bytes32 newRoot) external onlyAgentOwner(agentId) {
        uint64 eta = uint64(block.timestamp) + allowlistDelay;
        pendingAllowlist[agentId] = PendingRoot(newRoot, eta);
        emit AllowlistProposed(agentId, newRoot, eta);
    }

    /// @notice Permissionless: apply a pending allowlist once its timelock elapsed.
    function applyAllowlist(uint256 agentId) external {
        PendingRoot memory p = pendingAllowlist[agentId];
        if (p.eta == 0 || block.timestamp < p.eta) revert NotReady();
        bytes32 old = _agents[agentId].allowlistRoot;
        _agents[agentId].allowlistRoot = p.root;
        delete pendingAllowlist[agentId];
        emit AllowlistUpdated(agentId, old, p.root);
    }

    function updateEndpoint(uint256 agentId, string calldata endpoint) external onlyAgentOwner(agentId) {
        _checkEndpoint(endpoint);
        _agents[agentId].endpoint = endpoint;
        emit EndpointUpdated(agentId, endpoint);
    }

    function updateMetadata(uint256 agentId, string calldata metadataURI) external onlyAgentOwner(agentId) {
        _agents[agentId].metadataURI = metadataURI;
        emit MetadataUpdated(agentId, metadataURI);
    }

    /// @notice Status transitions driven by the arena (breach), exploit registry (gauntlet) or keeper.
    function setStatus(uint256 agentId, AgentStatus s) external {
        if (msg.sender != arena && msg.sender != exploits && msg.sender != keeper) revert NotAuthorized();
        if (_agents[agentId].owner == address(0)) revert UnknownAgent();
        _agents[agentId].status = s;
        if (s == AgentStatus.Breached) breachedAt[agentId] = uint64(block.timestamp);
        emit StatusChanged(agentId, s);
    }

    /// @notice Agent anchors a rolling hash of its decision log on-chain.
    function anchorDecision(uint256 agentId, bytes32 logHash, uint32 decisions) external {
        if (_agents[agentId].signer != msg.sender) revert NotSigner();
        emit DecisionAnchored(agentId, logHash, decisions);
    }

    // ───────────────────────────── views ─────────────────────────────

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return _agents[agentId];
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].owner;
    }

    function signerOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].signer;
    }

    function vaultOf(uint256 agentId) external view returns (address) {
        return _agents[agentId].vault;
    }

    function statusOf(uint256 agentId) external view returns (AgentStatus) {
        return _agents[agentId].status;
    }

    function allowlistRootOf(uint256 agentId) external view returns (bytes32) {
        return _agents[agentId].allowlistRoot;
    }

    function configChangedAtOf(uint256 agentId) external view returns (uint64) {
        return _agents[agentId].configChangedAt;
    }

    function _checkEndpoint(string calldata endpoint) internal view {
        bytes calldata e = bytes(endpoint);
        bool https = e.length > 8 && e[0] == "h" && e[1] == "t" && e[2] == "t" && e[3] == "p" && e[4] == "s"
            && e[5] == ":" && e[6] == "/" && e[7] == "/";
        bool http = e.length > 7 && e[0] == "h" && e[1] == "t" && e[2] == "t" && e[3] == "p" && e[4] == ":"
            && e[5] == "/" && e[6] == "/";
        if (!https && !(allowInsecureEndpoints && http)) revert BadEndpoint();
    }
}
