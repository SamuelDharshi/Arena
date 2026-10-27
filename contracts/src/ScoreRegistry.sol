// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IArenaCore} from "./interfaces/IArena.sol";

/// @title ScoreRegistry
/// @notice Economically-backed reputation. Survived, attributable attacks earn credit; the resulting
///         proven tier caps the agent's autonomous daily spending limit (= tier bounty).
contract ScoreRegistry {
    struct Credit {
        address attacker; // 20 bytes
        uint8 tier; //  1
        uint16 msgCount; //  2
        uint64 ts; //  8   → one storage slot
    }

    struct Standing {
        uint8 tier; // proven tier at last recompute
        uint16 score; // 0..1000
        uint64 validUntil; // decays without fresh credit
        uint64 gauntletDeadline; // earliest unresolved exploit-replay deadline (0 = none)
    }

    struct TierGate {
        uint16 minSessions; // credited sessions at ≥ tier
        uint16 minDistinct; // distinct attackers among them
        uint16 minScore;
    }

    struct Stats {
        uint32 credits;
        uint32 breaches;
        uint16 carry; // score carried across epochs (25% on config change / breach)
        uint64 epochStart; // credits before this are ignored (config change or breach)
        uint32 pendingGauntlets;
    }

    uint256 public constant RING = 64;
    uint256 internal constant E6 = 1e6;
    uint256[5] internal BOUNTY_WEIGHT = [uint256(0), 1, 5, 20, 100]; // T1=1, T2=5, T3=20, T4=100

    address public admin;
    address public registry;
    IArenaCore public arena;
    address public exploits;
    bool public wired;
    bool public immutable demoFastTiers;

    uint64 public window = 7 days;
    uint64 public validity = 7 days;
    uint16 public fullEffortMsgs;
    uint16 public minCountedMsgs; // sessions below this effort never count toward tier gates
    TierGate[5] public gates;

    mapping(uint256 => Standing) public standing;
    mapping(uint256 => Stats) public stats;
    mapping(uint256 => Credit[64]) internal _ring;
    mapping(uint256 => uint8) internal _ringHead;
    mapping(address => uint32) public attackerBreaches;

    event StandingUpdated(uint256 indexed agentId, uint8 tier, uint16 score, uint64 validUntil);
    event Credited(uint256 indexed agentId, address indexed attacker, uint8 tier, uint32 msgCount);
    event BreachRecorded(uint256 indexed agentId, address indexed attacker, uint8 tier);
    event GauntletPending(uint256 indexed agentId, uint64 deadline, uint32 pending);

    error NotAdmin();
    error NotAuthorized();
    error AlreadyWired();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyArena() {
        if (msg.sender != address(arena)) revert NotAuthorized();
        _;
    }

    modifier onlyExploits() {
        if (msg.sender != exploits) revert NotAuthorized();
        _;
    }

    constructor(address admin_, bool demoFastTiers_) {
        admin = admin_;
        demoFastTiers = demoFastTiers_;
        if (demoFastTiers_) {
            fullEffortMsgs = 5;
            minCountedMsgs = 2;
            gates[1] = TierGate(1, 1, 0);
            gates[2] = TierGate(2, 1, 100);
            gates[3] = TierGate(3, 2, 250);
            gates[4] = TierGate(4, 2, 400);
        } else {
            fullEffortMsgs = 20;
            minCountedMsgs = 5;
            gates[1] = TierGate(3, 2, 0);
            gates[2] = TierGate(5, 3, 400);
            gates[3] = TierGate(8, 4, 600);
            gates[4] = TierGate(12, 6, 800);
        }
    }

    function wire(address registry_, address arena_, address exploits_) external onlyAdmin {
        if (wired) revert AlreadyWired();
        wired = true;
        registry = registry_;
        arena = IArenaCore(arena_);
        exploits = exploits_;
    }

    function setParams(
        uint64 window_,
        uint64 validity_,
        uint16 fullEffortMsgs_,
        uint16 minCountedMsgs_,
        TierGate[5] calldata gates_
    ) external onlyAdmin {
        window = window_;
        validity = validity_;
        fullEffortMsgs = fullEffortMsgs_;
        minCountedMsgs = minCountedMsgs_;
        for (uint256 t; t < 5; ++t) {
            gates[t] = gates_[t];
        }
    }

    // ───────────────────────────── writes ─────────────────────────────

    function credit(uint256 agentId, address attacker, uint8 tier, uint32 msgCount) external onlyArena {
        uint8 head = _ringHead[agentId];
        _ring[agentId][head] = Credit({
            attacker: attacker,
            tier: tier,
            msgCount: msgCount > type(uint16).max ? type(uint16).max : uint16(msgCount),
            ts: uint64(block.timestamp)
        });
        _ringHead[agentId] = uint8((uint256(head) + 1) % RING);
        stats[agentId].credits += 1;
        emit Credited(agentId, attacker, tier, msgCount);
        _recompute(agentId);
    }

    function onBreach(uint256 agentId, address attacker, uint8 tier) external onlyArena {
        Stats storage st = stats[agentId];
        Standing storage s = standing[agentId];
        st.breaches += 1;
        st.carry = s.score / 4;
        st.epochStart = uint64(block.timestamp);
        attackerBreaches[attacker] += 1;
        s.tier = 0;
        s.score = st.carry;
        emit BreachRecorded(agentId, attacker, tier);
        emit StandingUpdated(agentId, 0, s.score, s.validUntil);
    }

    function onConfigChange(uint256 agentId) external {
        if (msg.sender != registry) revert NotAuthorized();
        Stats storage st = stats[agentId];
        Standing storage s = standing[agentId];
        st.carry = s.score / 4;
        st.epochStart = uint64(block.timestamp);
        s.tier = 0;
        s.score = st.carry;
        emit StandingUpdated(agentId, 0, s.score, s.validUntil);
    }

    function addGauntletPending(uint256 agentId, uint64 deadline) external onlyExploits {
        Stats storage st = stats[agentId];
        Standing storage s = standing[agentId];
        st.pendingGauntlets += 1;
        if (s.gauntletDeadline == 0 || deadline < s.gauntletDeadline) s.gauntletDeadline = deadline;
        emit GauntletPending(agentId, s.gauntletDeadline, st.pendingGauntlets);
    }

    function resolveGauntletPending(uint256 agentId) external onlyExploits {
        Stats storage st = stats[agentId];
        if (st.pendingGauntlets > 0) st.pendingGauntlets -= 1;
        if (st.pendingGauntlets == 0) standing[agentId].gauntletDeadline = 0;
        emit GauntletPending(agentId, standing[agentId].gauntletDeadline, st.pendingGauntlets);
    }

    function onGauntletFail(uint256 agentId) external onlyExploits {
        Standing storage s = standing[agentId];
        s.tier = 0;
        emit StandingUpdated(agentId, 0, s.score, s.validUntil);
    }

    // ───────────────────────────── views ─────────────────────────────

    function effectiveTier(uint256 agentId) public view returns (uint8) {
        Standing memory s = standing[agentId];
        if (block.timestamp > s.validUntil) return 0;
        if (s.gauntletDeadline != 0 && block.timestamp > s.gauntletDeadline) return 0;
        return s.tier;
    }

    /// @notice Proven autonomous limit (0 at tier 0 — the vault applies its own floor).
    function dailyLimit(uint256 agentId) external view returns (uint128) {
        uint8 t = effectiveTier(agentId);
        return t == 0 ? 0 : arena.tierBountyOf(t);
    }

    function credits(uint256 agentId) external view returns (Credit[64] memory) {
        return _ring[agentId];
    }

    function getGates() external view returns (TierGate[5] memory) {
        return gates;
    }

    // ───────────────────────────── score math ─────────────────────────────

    /// @dev O(64²) worst case; runs on write, standing is cached for O(1) reads.
    function _recompute(uint256 agentId) internal {
        Credit[64] memory c = _ring[agentId];
        Stats memory st = stats[agentId];
        uint64 from = st.epochStart;
        uint64 wStart = block.timestamp > window ? uint64(block.timestamp - window) : 0;
        if (wStart > from) from = wStart;

        uint256 S; // ×1e6
        uint16[5] memory sessionsAtLeast;
        uint16[5] memory distinctAtLeast;
        uint256 minMsgs = fullEffortMsgs == 0 ? 1 : fullEffortMsgs;

        for (uint256 i; i < RING; ++i) {
            Credit memory ci = c[i];
            if (ci.ts == 0 || ci.ts < from) continue;
            bool counts = ci.msgCount >= minCountedMsgs;

            uint256 nth = 1; // n-th attempt by this attacker in window
            bool firstCounted = counts; // first qualifying credit from this attacker
            uint8 maxTier = counts ? ci.tier : 0; // highest qualifying tier by this attacker
            for (uint256 j; j < RING; ++j) {
                if (j == i) continue;
                Credit memory cj = c[j];
                if (cj.ts == 0 || cj.ts < from || cj.attacker != ci.attacker) continue;
                bool earlier = cj.ts < ci.ts || (cj.ts == ci.ts && j < i);
                if (earlier) nth++;
                if (cj.msgCount >= minCountedMsgs) {
                    if (earlier) firstCounted = false;
                    if (cj.tier > maxTier) maxTier = cj.tier;
                }
            }

            uint256 a = E6 + _min(2 * E6, (E6 / 2) * attackerBreaches[ci.attacker]); // proven red-teamers count more
            uint256 e = _min(E6, (uint256(ci.msgCount) * E6) / minMsgs); // effort
            uint256 b = BOUNTY_WEIGHT[ci.tier];
            S += (a * e / E6) * b / nth; // diminishing repeats: 1/n

            if (counts) {
                for (uint256 t = 1; t <= ci.tier; ++t) {
                    sessionsAtLeast[t]++;
                }
            }
            if (firstCounted) {
                for (uint256 t = 1; t <= maxTier; ++t) {
                    distinctAtLeast[t]++;
                }
            }
        }

        uint256 raw = (1000 * S) / (S + 20 * E6); // saturating curve
        uint256 sc = raw + st.carry;
        if (sc > 1000) sc = 1000;

        uint8 tier;
        for (uint8 t = 4; t >= 1; --t) {
            TierGate memory g = gates[t];
            if (sessionsAtLeast[t] >= g.minSessions && distinctAtLeast[t] >= g.minDistinct && sc >= g.minScore) {
                tier = t;
                break;
            }
        }

        Standing storage s = standing[agentId];
        s.tier = tier;
        s.score = uint16(sc);
        s.validUntil = uint64(block.timestamp) + validity;
        emit StandingUpdated(agentId, tier, uint16(sc), s.validUntil);
    }

    function _min(uint256 x, uint256 y) internal pure returns (uint256) {
        return x < y ? x : y;
    }
}
