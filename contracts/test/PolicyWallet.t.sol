// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Base} from "./Base.t.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Intent, Policy} from "../src/libs/Types.sol";

contract PolicyWalletTest is Base {
    uint256 id;
    PolicyWallet vault;

    function setUp() public {
        _deploy(true);
        (id, vault) = _register(signer);
        _fund(vault, 2000 * USD, 500 * USD);
    }

    function test_register_deploysVault() public view {
        assertEq(registry.agentCount(), 1);
        assertEq(registry.ownerOf(id), owner);
        assertEq(address(vault), factory.predict(id));
        assertEq(vault.treasury(), 2000 * USD);
        assertEq(vault.bountyPool(), 500 * USD);
        assertEq(usdc.balanceOf(address(vault)), 2500 * USD);
    }

    function test_register_rejectsSignerEqOwner() public {
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.BadSigner.selector);
        registry.registerAgent(owner, 0, 0, root, "https://x", "", _policy());
    }

    function test_register_rejectsDuplicateSigner() public {
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.BadSigner.selector);
        registry.registerAgent(signer, 0, 0, root, "https://x", "", _policy());
    }

    function test_register_rejectsBadEndpoint() public {
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.BadEndpoint.selector);
        registry.registerAgent(makeAddr("s2"), 0, 0, root, "ftp://x", "", _policy());
    }

    function test_production_underLimitClears() public {
        Intent memory i = _intent(id, vendorA, 5 * USD);
        vm.prank(signer);
        vault.payProduction(i, _proof(vendorA), "");
        assertEq(usdc.balanceOf(vendorA), 5 * USD);
        assertEq(vault.spentInWindow(), 5 * USD);
    }

    function test_production_overLimitNeedsOwner() public {
        Intent memory i = _intent(id, vendorA, 11 * USD); // floor limit = 10
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.EscalationRequired.selector);
        vault.payProduction(i, _proof(vendorA), "");

        bytes memory sig = _ownerSig(vault, i);
        vm.expectEmit(true, true, false, true);
        emit PolicyWallet.ProductionPayment(id, vendorA, 11 * USD, i.category, i.ref, true, i.nonce);
        vm.prank(signer);
        vault.payProduction(i, _proof(vendorA), sig);
        assertEq(usdc.balanceOf(vendorA), 11 * USD);
    }

    function test_production_rollingWindowAccumulates() public {
        vm.startPrank(signer);
        vault.payProduction(_intent(id, vendorA, 6 * USD), _proof(vendorA), "");
        Intent memory i2 = _intent(id, vendorB, 6 * USD);
        vm.expectRevert(PolicyWallet.EscalationRequired.selector);
        vault.payProduction(i2, _proof(vendorB), "");
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1 hours); // window rolls over
        vm.prank(signer);
        vault.payProduction(_intent(id, vendorB, 6 * USD), _proof(vendorB), "");
    }

    function test_production_aboveApprovalThresholdNeedsOwner() public {
        Intent memory i = _intent(id, vendorA, 501 * USD);
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.EscalationRequired.selector);
        vault.payProduction(i, _proof(vendorA), "");
    }

    function test_production_rejectsWrongOwnerSig() public {
        Intent memory i = _intent(id, vendorA, 50 * USD);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, vault.hashIntent(i));
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.EscalationRequired.selector);
        vault.payProduction(i, _proof(vendorA), abi.encodePacked(r, s, v));
    }

    function test_production_notAllowlisted() public {
        Intent memory i = _intent(id, attacker, 1 * USD);
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.NotAllowlisted.selector);
        vault.payProduction(i, _proof(vendorA), "");
    }

    function test_production_perTxCap() public {
        Intent memory i = _intent(id, vendorA, 1001 * USD);
        bytes memory sig = _ownerSig(vault, i);
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.PerTxCap.selector);
        vault.payProduction(i, _proof(vendorA), sig);
    }

    function test_production_nonceReplay() public {
        Intent memory i = _intent(id, vendorA, 1 * USD);
        vm.startPrank(signer);
        vault.payProduction(i, _proof(vendorA), "");
        vm.expectRevert(PolicyWallet.BadIntent.selector);
        vault.payProduction(i, _proof(vendorA), "");
        vm.stopPrank();
    }

    function test_production_expiredDeadline() public {
        Intent memory i = _intent(id, vendorA, 1 * USD);
        vm.warp(i.deadline + 1);
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.BadIntent.selector);
        vault.payProduction(i, _proof(vendorA), "");
    }

    function test_production_onlySigner() public {
        Intent memory i = _intent(id, vendorA, 1 * USD);
        vm.prank(owner);
        vm.expectRevert(PolicyWallet.NotSigner.selector);
        vault.payProduction(i, _proof(vendorA), "");
    }

    function test_bounty_nonSessionRecipientReverts() public {
        Intent memory i = _intent(id, attacker, 50 * USD);
        vm.prank(signer);
        vm.expectRevert(PolicyWallet.RecipientNotAllowed.selector);
        vault.payBounty(i, new bytes32[](0));
    }

    function test_bounty_allowlistedVendorPaid() public {
        Intent memory i = _intent(id, vendorB, 3 * USD);
        vm.prank(signer);
        vault.payBounty(i, _proof(vendorB));
        assertEq(vault.bountyPool(), 497 * USD);
        assertEq(usdc.balanceOf(vendorB), 3 * USD);
    }

    function test_withdraw_onlyFreeBounty() public {
        _open(id, attacker, 2); // locks 250
        vm.startPrank(owner);
        vm.expectRevert(PolicyWallet.InsufficientFunds.selector);
        vault.withdrawBounty(251 * USD);
        vault.withdrawBounty(250 * USD);
        vm.stopPrank();
        assertEq(vault.freeBounty(), 0);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PolicyWallet.NotOwner.selector);
        vault.withdrawTreasury(1);
    }

    function test_cannotReinitialize() public {
        Policy memory p = _policy();
        vm.expectRevert(PolicyWallet.AlreadyInitialized.selector);
        vault.initialize(9, address(usdc), address(registry), address(arena), address(score), p);
    }

    function test_allowlistTimelock() public {
        vm.prank(owner);
        registry.updateAllowlist(id, bytes32(uint256(1)));
        vm.expectRevert(AgentRegistry.NotReady.selector);
        registry.applyAllowlist(id);
        vm.warp(block.timestamp + 1 hours);
        registry.applyAllowlist(id);
        assertEq(registry.allowlistRootOf(id), bytes32(uint256(1)));
    }
}
