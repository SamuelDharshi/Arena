// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base} from "./Base.t.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {ArenaCore} from "../src/ArenaCore.sol";
import {ExploitRegistry} from "../src/ExploitRegistry.sol";
import {Intent, Attestation, AgentStatus, SessionState} from "../src/libs/Types.sol";

contract ArenaTest is Base {
    uint256 id;
    PolicyWallet vault;

    function setUp() public {
        _deploy(true);
        (id, vault) = _register(signer);
        _fund(vault, 2000 * USD, 1000 * USD);
    }

    function test_openSession_locksBountyAndTakesFee() public {
        uint256 sid = _open(id, attacker, 1);
        assertEq(sid, 1);
        assertEq(vault.lockedBounty(), 50 * USD);
        assertEq(usdc.balanceOf(address(arena)), 1 * USD);
        assertEq(arena.liveSessionOf(id, attacker), sid);
    }

    function test_openSession_rejectsSelfAttack() public {
        usdc.mint(owner, 10 * USD);
        vm.startPrank(owner);
        usdc.approve(address(arena), 10 * USD);
        vm.expectRevert(ArenaCore.BadAttacker.selector);
        arena.openSession(id, 1, owner);
        vm.expectRevert(ArenaCore.BadAttacker.selector);
        arena.openSession(id, 1, attacker); // owner paying for someone else
        vm.stopPrank();
    }

    function test_openSession_oneLivePerAttacker() public {
        _open(id, attacker, 1);
        usdc.mint(attacker, 1 * USD);
        vm.startPrank(attacker);
        usdc.approve(address(arena), 1 * USD);
        vm.expectRevert(ArenaCore.SessionLive.selector);
        arena.openSession(id, 1, attacker);
        vm.stopPrank();
    }

    function test_openSession_dailyAttemptCap() public {
        for (uint256 k; k < 5; ++k) {
            uint256 sid = _open(id, attacker, 1);
            (Attestation memory a, bytes memory sig) = _attest(sid, 1);
            arena.closeSession(a, sig);
        }
        usdc.mint(attacker, 1 * USD);
        vm.startPrank(attacker);
        usdc.approve(address(arena), 1 * USD);
        vm.expectRevert(ArenaCore.TooManyAttempts.selector);
        arena.openSession(id, 1, attacker);
        vm.stopPrank();
    }

    function test_openSession_insufficientBounty() public {
        usdc.mint(attacker, 25 * USD);
        vm.startPrank(attacker);
        usdc.approve(address(arena), 25 * USD);
        vm.expectRevert(PolicyWallet.InsufficientFunds.selector);
        arena.openSession(id, 4, attacker); // needs 5000
        vm.stopPrank();
    }

    function test_breach_paysAttackerAutomatically() public {
        uint256 sid = _open(id, attacker, 1);
        uint256 before = usdc.balanceOf(attacker);

        Intent memory i = _intent(id, attacker, 1000 * USD); // asks for more than locked
        vm.prank(signer);
        vault.payBounty(i, new bytes32[](0));

        assertEq(usdc.balanceOf(attacker) - before, 50 * USD + 1 * USD); // bounty + fee refund
        ArenaCore.Session memory s = arena.getSession(sid);
        assertEq(uint8(s.state), uint8(SessionState.Breached));
        assertEq(s.payout, 50 * USD);
        assertEq(vault.lockedBounty(), 0);
        assertEq(vault.bountyPool(), 950 * USD);
        assertEq(uint8(registry.statusOf(id)), uint8(AgentStatus.Breached));
        assertEq(score.effectiveTier(id), 0);
    }

    function test_breach_partialAmount() public {
        _open(id, attacker, 2);
        Intent memory i = _intent(id, attacker, 10 * USD);
        vm.prank(signer);
        vault.payBounty(i, new bytes32[](0));
        assertEq(vault.bountyPool(), 990 * USD);
        assertEq(vault.lockedBounty(), 0); // rest of the lock released
    }

    function test_breach_onlyLiveSessionAttacker() public {
        _open(id, attacker, 1);
        Intent memory i = _intent(id, attacker2, 50 * USD);
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.RecipientNotAllowed.selector);
        vault.payBounty(i, new bytes32[](0));
    }

    function test_breach_afterExpiryReverts() public {
        _open(id, attacker, 1);
        vm.warp(block.timestamp + 31 minutes);
        Intent memory i = _intent(id, attacker, 50 * USD);
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.RecipientNotAllowed.selector);
        vault.payBounty(i, new bytes32[](0));
    }

    function test_breachedAgentCannotBeAttackedUntilPatched() public {
        _open(id, attacker, 1);
        vm.prank(signer);
        vault.payBounty(_intent(id, attacker, 50 * USD), new bytes32[](0));

        usdc.mint(attacker2, 1 * USD);
        vm.startPrank(attacker2);
        usdc.approve(address(arena), 1 * USD);
        vm.expectRevert(ArenaCore.NotActive.selector);
        arena.openSession(id, 1, attacker2);
        vm.stopPrank();

        vm.prank(owner);
        vm.expectRevert(); // cooldown
        registry.updateConfig(id, keccak256("config-v2"));

        vm.warp(block.timestamp + 1 hours);
        vm.prank(owner);
        registry.updateConfig(id, keccak256("config-v2"));
        assertEq(uint8(registry.statusOf(id)), uint8(AgentStatus.Active));
        _open(id, attacker2, 1);
    }

    function test_close_survivalCreditsAndSplitsFee() public {
        uint256 sid = _open(id, attacker, 2); // fee 2.5
        (Attestation memory a, bytes memory sig) = _attest(sid, 12);
        arena.closeSession(a, sig);

        ArenaCore.Session memory s = arena.getSession(sid);
        assertEq(uint8(s.state), uint8(SessionState.Survived));
        assertEq(vault.lockedBounty(), 0);
        assertEq(vault.bountyPool(), 1000 * USD + 1.75e6);
        assertEq(usdc.balanceOf(address(grant)), 0.75e6);
        (, uint16 sc,,) = score.standing(id);
        assertGt(sc, 0);
    }

    function test_close_rejectsForgedAttestation() public {
        uint256 sid = _open(id, attacker, 1);
        (Attestation memory a,) = _attest(sid, 12);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, arena.attestationDigest(a));
        vm.expectRevert(ArenaCore.BadAttestation.selector);
        arena.closeSession(a, abi.encodePacked(r, s, v));
    }

    function test_close_afterBreachReverts() public {
        uint256 sid = _open(id, attacker, 1);
        vm.prank(signer);
        vault.payBounty(_intent(id, attacker, 50 * USD), new bytes32[](0));
        (Attestation memory a, bytes memory sig) = _attest(sid, 12);
        vm.expectRevert(ArenaCore.NotOpen.selector);
        arena.closeSession(a, sig);
    }

    function test_expireStale_refundsNoCredit() public {
        uint256 sid = _open(id, attacker, 1);
        vm.expectRevert(ArenaCore.NotExpired.selector);
        arena.expireStale(sid);
        vm.warp(block.timestamp + 30 minutes + 1 hours + 1);
        arena.expireStale(sid);
        assertEq(usdc.balanceOf(attacker), 1 * USD);
        assertEq(vault.lockedBounty(), 0);
        (, uint16 sc,,) = score.standing(id);
        assertEq(sc, 0);
    }

    function test_keeperCanExpireWithoutGrace() public {
        uint256 sid = _open(id, attacker, 1);
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(keeper);
        arena.expireStale(sid);
    }

    /// @notice P0-7: the same production payment reverts at the floor and clears after tier unlock.
    function test_e2e_scoreGatesDailyLimit() public {
        Intent memory pay = _intent(id, vendorA, 200 * USD);
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.EscalationRequired.selector);
        vault.payProduction(pay, _proof(vendorA), "");

        // demo gates: T2 = 2 sessions ≥T2, 1 distinct attacker, score ≥ 100
        _survive(id, attacker, 2, 10);
        _survive(id, attacker2, 2, 10);
        assertEq(score.effectiveTier(id), 2);
        assertEq(vault.dailyLimit(), 250 * USD);

        vm.prank(signer);
        vault.payProduction(pay, _proof(vendorA), "");
        assertEq(usdc.balanceOf(vendorA), 200 * USD);
    }

    function test_score_decaysWithoutFreshCredit() public {
        _survive(id, attacker, 1, 10);
        assertEq(score.effectiveTier(id), 1);
        vm.warp(block.timestamp + 7 days + 1);
        assertEq(score.effectiveTier(id), 0);
        assertEq(vault.dailyLimit(), 10 * USD);
    }

    function test_score_configChangeResetsTierKeeps25pct() public {
        _survive(id, attacker, 2, 10);
        _survive(id, attacker2, 2, 10);
        (, uint16 before,,) = score.standing(id);
        vm.prank(owner);
        registry.updateConfig(id, keccak256("config-v2"));
        (uint8 t, uint16 afterScore,,) = score.standing(id);
        assertEq(t, 0);
        assertEq(afterScore, before / 4);
    }

    function test_score_repeatAttackerDiminishes() public {
        _survive(id, attacker, 2, 10);
        (, uint16 s1,,) = score.standing(id);
        _survive(id, attacker, 2, 10);
        (, uint16 s2,,) = score.standing(id);
        _survive(id, attacker2, 2, 10);
        (, uint16 s3,,) = score.standing(id);
        assertGt(s3 - s2, s2 - s1); // fresh attacker counts more than a repeat
    }

    function test_exploit_publishGauntletAndSuspend() public {
        // second agent that will be replayed against
        uint256 signer2Pk = 0xB0B;
        (uint256 id2, PolicyWallet vault2) = _register(vm.addr(signer2Pk));
        _fund(vault2, 0, 100 * USD);
        _survive(id2, attacker2, 1, 10);
        assertEq(score.effectiveTier(id2), 1);

        uint256 sid = _open(id, attacker, 1);
        vm.prank(signer);
        vault.payBounty(_intent(id, attacker, 50 * USD), new bytes32[](0));

        // fund the grant pool so the discoverer bonus is paid
        usdc.mint(address(grant), 100 * USD);
        vm.prank(attestor);
        uint256 eid = exploits.publish(sid, "https://gw/t/1", keccak256("t"), keccak256("f"));
        assertEq(eid, 1);
        assertEq(usdc.balanceOf(attacker), 51 * USD + 5 * USD); // bounty + fee refund + 10% bonus
        assertEq(uint8(exploits.results(eid, id2)), uint8(ExploitRegistry.Result.Pending));

        // still tiered until deadline passes
        assertEq(score.effectiveTier(id2), 1);
        vm.warp(block.timestamp + 6 hours + 1);
        assertEq(score.effectiveTier(id2), 0);

        vm.prank(keeper);
        exploits.postGauntletResult(id2, eid, false, keccak256("run"));
        assertEq(uint8(registry.statusOf(id2)), uint8(AgentStatus.Suspended));

        vm.expectRevert(ExploitRegistry.AlreadyPublished.selector);
        vm.prank(attestor);
        exploits.publish(sid, "x", 0, 0);
    }

    function test_exploit_passClearsPending() public {
        (uint256 id2, PolicyWallet vault2) = _register(vm.addr(0xB0B));
        _fund(vault2, 0, 100 * USD);
        _survive(id2, attacker2, 1, 10);

        uint256 sid = _open(id, attacker, 1);
        vm.prank(signer);
        vault.payBounty(_intent(id, attacker, 50 * USD), new bytes32[](0));
        vm.prank(attacker);
        uint256 eid = exploits.publish(sid, "u", 0, 0);

        vm.prank(keeper);
        exploits.postGauntletResult(id2, eid, true, keccak256("run"));
        vm.warp(block.timestamp + 7 hours);
        assertEq(score.effectiveTier(id2), 1);
    }

    function test_exploit_publishOnlyAuthorized() public {
        uint256 sid = _open(id, attacker, 1);
        vm.prank(signer);
        vault.payBounty(_intent(id, attacker, 50 * USD), new bytes32[](0));
        vm.prank(attacker3);
        vm.expectRevert(ExploitRegistry.NotAuthorized.selector);
        exploits.publish(sid, "u", 0, 0);
    }

    function test_close_concurrentSessionAfterBreachGetsNoCredit() public {
        uint256 sidA = _open(id, attacker, 1);
        _open(id, attacker2, 1);
        vm.prank(signer);
        vault.payBounty(_intent(id, attacker2, 50 * USD), new bytes32[](0));
        (Attestation memory a, bytes memory sig) = _attest(sidA, 20);
        arena.closeSession(a, sig);
        assertEq(uint8(arena.getSession(sidA).state), uint8(SessionState.Expired));
        assertEq(usdc.balanceOf(attacker), 1 * USD); // fee refunded
        assertEq(score.effectiveTier(id), 0);
        assertEq(vault.lockedBounty(), 0);
    }

    function test_score_lowEffortSessionsDontCountForTier() public {
        _survive(id, attacker, 1, 1); // 1 message < minCountedMsgs (2 in demo)
        assertEq(score.effectiveTier(id), 0);
        _survive(id, attacker2, 1, 2);
        assertEq(score.effectiveTier(id), 1);
    }
}
