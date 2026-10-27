// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base, TestUSDC} from "./Base.t.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {ArenaCore} from "../src/ArenaCore.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Intent, Attestation, AgentStatus, SessionState} from "../src/libs/Types.sol";

/// @dev Fuzz handler: deposit, withdraw, openSession, breach, close, expire, production pay.
contract Handler is Test {
    Base internal b;
    TestUSDC internal usdc;
    PolicyWallet internal vault;
    ArenaCore internal arena;
    ScoreRegistry internal score;
    AgentRegistry internal registry;
    uint256 internal id;
    address internal owner;
    address internal signer;
    uint256 internal ownerPk;
    uint256 internal attestorPk;
    address internal vendor;
    bytes32[] internal vendorProof;

    address[] internal attackers;
    uint256[] public sids;
    uint64 internal nonce = 1_000_000;

    // ghost state
    uint256 public ghostBreachPaidToNonAttacker;
    uint256 public ghostPayoutOverLock;
    uint256 public ghostUncosignedOverLimit;
    uint256 public ghostTierWithoutCredit;
    uint256 public ghostBreachedWithTier;

    constructor(
        TestUSDC usdc_,
        PolicyWallet vault_,
        ArenaCore arena_,
        ScoreRegistry score_,
        AgentRegistry registry_,
        uint256 id_,
        uint256 ownerPk_,
        address signer_,
        uint256 attestorPk_,
        address vendor_,
        bytes32[] memory proof_
    ) {
        usdc = usdc_;
        vault = vault_;
        arena = arena_;
        score = score_;
        registry = registry_;
        id = id_;
        ownerPk = ownerPk_;
        owner = vm.addr(ownerPk_);
        signer = signer_;
        attestorPk = attestorPk_;
        vendor = vendor_;
        vendorProof = proof_;
        for (uint256 k; k < 4; ++k) {
            attackers.push(makeAddr(string(abi.encode("atk", k))));
        }
    }

    function depositBounty(uint96 amt) external {
        amt = uint96(bound(amt, 1, 10_000e6));
        usdc.mint(owner, amt);
        vm.startPrank(owner);
        usdc.approve(address(vault), amt);
        vault.depositBounty(uint128(amt));
        vm.stopPrank();
    }

    function depositTreasury(uint96 amt) external {
        amt = uint96(bound(amt, 1, 10_000e6));
        usdc.mint(owner, amt);
        vm.startPrank(owner);
        usdc.approve(address(vault), amt);
        vault.depositTreasury(uint128(amt));
        vm.stopPrank();
    }

    function withdrawBounty(uint96 amt) external {
        uint128 free = vault.freeBounty();
        if (free == 0) return;
        amt = uint96(bound(amt, 1, free));
        vm.prank(owner);
        vault.withdrawBounty(uint128(amt));
    }

    function openSession(uint8 who, uint8 tier) external {
        if (registry.statusOf(id) != AgentStatus.Active) return;
        tier = uint8(bound(tier, 1, 2));
        address a = attackers[who % attackers.length];
        uint128 f = arena.tierFee(tier);
        usdc.mint(a, f);
        vm.startPrank(a);
        usdc.approve(address(arena), f);
        try arena.openSession(id, tier, a) returns (uint256 sid) {
            sids.push(sid);
        } catch {}
        vm.stopPrank();
    }

    function breach(uint8 who, uint96 amt) external {
        address a = attackers[who % attackers.length];
        uint256 sid = arena.liveSessionOf(id, a);
        amt = uint96(bound(amt, 1, 10_000e6));
        uint256 before = usdc.balanceOf(a);
        Intent memory i = Intent(id, a, uint128(amt), bytes32(0), bytes32(0), nonce++, uint64(block.timestamp + 1));
        vm.prank(signer);
        try vault.payBounty(i, new bytes32[](0)) {
            if (sid == 0) ghostBreachPaidToNonAttacker++;
            ArenaCore.Session memory s = arena.getSession(sid);
            if (s.payout > s.lockedBounty) ghostPayoutOverLock++;
            if (usdc.balanceOf(a) - before > s.lockedBounty + s.fee) ghostPayoutOverLock++;
            if (score.effectiveTier(id) != 0) ghostBreachedWithTier++;
        } catch {}
    }

    function close(uint256 idx, uint16 msgs) external {
        if (sids.length == 0) return;
        uint256 sid = sids[idx % sids.length];
        (uint8 tBefore,,,) = score.standing(id);
        Attestation memory at = Attestation(sid, uint32(bound(msgs, 0, 40)), keccak256(abi.encode(sid)), uint64(block.timestamp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, arena.attestationDigest(at));
        try arena.closeSession(at, abi.encodePacked(r, s, v)) {} catch {}
        (uint8 tAfter,,,) = score.standing(id);
        if (tAfter > tBefore && arena.getSession(sid).state != SessionState.Survived) ghostTierWithoutCredit++;
    }

    function expire(uint256 idx) external {
        if (sids.length == 0) return;
        uint256 sid = sids[idx % sids.length];
        vm.prank(arena.keeper());
        try arena.expireStale(sid) {} catch {}
    }

    function payProduction(uint96 amt, bool cosign) external {
        amt = uint96(bound(amt, 1, 2_000e6));
        Intent memory i = Intent(id, vendor, uint128(amt), bytes32(0), bytes32(0), nonce++, uint64(block.timestamp + 1));
        bytes memory sig;
        if (cosign) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, vault.hashIntent(i));
            sig = abi.encodePacked(r, s, v);
        }
        uint128 limit = vault.dailyLimit();
        uint128 used = vault.spentInWindow();
        (uint128 perTx, uint128 threshold,,) = vault.policy();
        vm.prank(signer);
        try vault.payProduction(i, vendorProof, sig) {
            if (!cosign && (used + amt > limit || amt > threshold)) ghostUncosignedOverLimit++;
            if (amt > perTx) ghostUncosignedOverLimit++;
        } catch {}
    }

    function patch() external {
        vm.warp(block.timestamp + 2 hours);
        vm.prank(owner);
        try registry.updateConfig(id, keccak256(abi.encode(block.timestamp))) {} catch {}
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
    }
}

contract InvariantTest is Base {
    Handler handler;
    uint256 id;
    PolicyWallet vault;

    function setUp() public {
        _deploy(true);
        (id, vault) = _register(signer);
        _fund(vault, 1000 * USD, 1000 * USD);
        handler = new Handler(
            usdc, vault, arena, score, registry, id, ownerPk, signer, attestorPk, vendorA, _proof(vendorA)
        );
        targetContract(address(handler));
    }

    /// I1 lockedBounty ≤ bountyPool
    function invariant_lockedLeqPool() public view {
        assertLe(vault.lockedBounty(), vault.bountyPool());
    }

    /// I2 vault accounting ≤ USDC balance
    function invariant_accountingSolvent() public view {
        assertLe(uint256(vault.bountyPool()) + vault.treasury(), usdc.balanceOf(address(vault)));
    }

    /// I3 payout ≤ lockedBounty
    function invariant_payoutLeqLock() public view {
        assertEq(handler.ghostPayoutOverLock(), 0);
    }

    /// I4 breach pays only the session's attacker
    function invariant_breachOnlyToSessionAttacker() public view {
        assertEq(handler.ghostBreachPaidToNonAttacker(), 0);
    }

    /// I5 production spend ≤ dailyLimit unless co-signed
    function invariant_productionWithinLimit() public view {
        assertEq(handler.ghostUncosignedOverLimit(), 0);
    }

    /// I6 tier increases only after credit
    function invariant_tierOnlyAfterCredit() public view {
        assertEq(handler.ghostTierWithoutCredit(), 0);
    }

    /// I7 breach ⇒ effectiveTier == 0
    function invariant_breachZeroesTier() public view {
        assertEq(handler.ghostBreachedWithTier(), 0);
        if (registry.statusOf(id) == AgentStatus.Breached) assertEq(score.effectiveTier(id), 0);
    }
}
