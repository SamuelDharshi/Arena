// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {PolicyWalletFactory} from "../src/PolicyWalletFactory.sol";
import {ArenaCore} from "../src/ArenaCore.sol";
import {ScoreRegistry} from "../src/ScoreRegistry.sol";
import {ExploitRegistry} from "../src/ExploitRegistry.sol";
import {GrantPool} from "../src/GrantPool.sol";
import {Policy, Intent, Attestation} from "../src/libs/Types.sol";
import {MerkleLib} from "../src/libs/MerkleLib.sol";

/// @dev 6-decimal ERC-20 standing in for Arc's USDC interface inside unit tests only.
contract TestUSDC is ERC20("USD Coin", "USDC") {
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

abstract contract Base is Test {
    TestUSDC usdc;
    AgentRegistry registry;
    ScoreRegistry score;
    ArenaCore arena;
    GrantPool grant;
    ExploitRegistry exploits;
    PolicyWalletFactory factory;

    address admin = makeAddr("admin");
    address keeper = makeAddr("keeper");
    uint256 attestorPk = 0xA77E57;
    address attestor;
    uint256 ownerPk = 0x0A11CE;
    address owner;
    uint256 signerPk = 0x5161E5;
    address signer;
    address vendorA = makeAddr("vendorA");
    address vendorB = makeAddr("vendorB");
    address attacker = makeAddr("attacker");
    address attacker2 = makeAddr("attacker2");
    address attacker3 = makeAddr("attacker3");

    uint128 constant USD = 1e6;
    uint128[5] bounty = [uint128(0), 50 * USD, 250 * USD, 1000 * USD, 5000 * USD];
    uint128[5] fee = [uint128(0), 1 * USD, 2.5e6, 10 * USD, 25 * USD];

    bytes32 root;
    uint64 nonce = 1;

    function _deploy(bool demo) internal {
        attestor = vm.addr(attestorPk);
        owner = vm.addr(ownerPk);
        signer = vm.addr(signerPk);
        usdc = new TestUSDC();

        registry = new AgentRegistry(admin, 1 hours, true);
        score = new ScoreRegistry(admin, demo);
        arena = new ArenaCore(address(usdc), address(registry), admin, attestor, bounty, fee, 30 minutes);
        grant = new GrantPool(address(usdc), admin);
        exploits =
            new ExploitRegistry(address(arena), address(registry), address(score), address(grant), admin, keeper);
        PolicyWallet impl = new PolicyWallet();
        factory = new PolicyWalletFactory(address(impl), address(registry), address(usdc), address(arena), address(score));

        vm.startPrank(admin);
        registry.wire(address(factory), address(score), address(arena), address(exploits), keeper);
        score.wire(address(registry), address(arena), address(exploits));
        arena.wire(address(score), address(grant), keeper);
        grant.wire(address(exploits));
        vm.stopPrank();

        root = Hashes.commutativeKeccak256(MerkleLib.leaf(vendorA), MerkleLib.leaf(vendorB));
    }

    function _proof(address v) internal view returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = MerkleLib.leaf(v == vendorA ? vendorB : vendorA);
    }

    function _policy() internal pure returns (Policy memory) {
        return Policy({perTxCap: 1000 * USD, approvalThreshold: 500 * USD, windowSecs: 1 days, floorDailyLimit: 10 * USD});
    }

    function _register(address agentSigner) internal returns (uint256 id, PolicyWallet vault) {
        vm.prank(owner);
        id = registry.registerAgent(
            agentSigner, keccak256("config-v1"), keccak256("mandate"), root, "https://agent.example", "ipfs://meta", _policy()
        );
        vault = PolicyWallet(registry.vaultOf(id));
    }

    function _fund(PolicyWallet vault, uint128 treasuryAmt, uint128 bountyAmt) internal {
        usdc.mint(owner, treasuryAmt + bountyAmt);
        vm.startPrank(owner);
        usdc.approve(address(vault), treasuryAmt + bountyAmt);
        if (treasuryAmt > 0) vault.depositTreasury(treasuryAmt);
        if (bountyAmt > 0) vault.depositBounty(bountyAmt);
        vm.stopPrank();
    }

    function _intent(uint256 id, address to, uint128 amount) internal returns (Intent memory i) {
        i = Intent({
            agentId: id,
            to: to,
            amount: amount,
            category: keccak256("SaaS"),
            ref: keccak256(abi.encode(nonce)),
            nonce: nonce++,
            deadline: uint64(block.timestamp + 1 hours)
        });
    }

    function _ownerSig(PolicyWallet vault, Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, vault.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _open(uint256 id, address who, uint8 tier) internal returns (uint256 sid) {
        usdc.mint(who, fee[tier]);
        vm.startPrank(who);
        usdc.approve(address(arena), fee[tier]);
        sid = arena.openSession(id, tier, who);
        vm.stopPrank();
    }

    function _attest(uint256 sid, uint32 msgs) internal view returns (Attestation memory a, bytes memory sig) {
        a = Attestation({sid: sid, msgCount: msgs, transcriptRoot: keccak256(abi.encode(sid, msgs)), endedAt: uint64(block.timestamp)});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attestorPk, arena.attestationDigest(a));
        sig = abi.encodePacked(r, s, v);
    }

    function _survive(uint256 id, address who, uint8 tier, uint32 msgs) internal {
        uint256 sid = _open(id, who, tier);
        (Attestation memory a, bytes memory sig) = _attest(sid, msgs);
        arena.closeSession(a, sig);
    }
}
