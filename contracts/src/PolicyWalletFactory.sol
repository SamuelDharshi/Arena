// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Policy} from "./libs/Types.sol";
import {IPolicyWallet} from "./interfaces/IArena.sol";

/// @title PolicyWalletFactory
/// @notice Deploys an ERC-1167 PolicyWallet clone per agent. Only the registry may deploy.
contract PolicyWalletFactory {
    address public immutable implementation;
    address public immutable registry;
    address public immutable usdc;
    address public immutable arena;
    address public immutable score;

    event VaultDeployed(uint256 indexed agentId, address vault);

    error NotRegistry();

    constructor(address implementation_, address registry_, address usdc_, address arena_, address score_) {
        implementation = implementation_;
        registry = registry_;
        usdc = usdc_;
        arena = arena_;
        score = score_;
    }

    function deploy(uint256 agentId, Policy calldata policy) external returns (address vault) {
        if (msg.sender != registry) revert NotRegistry();
        vault = Clones.cloneDeterministic(implementation, bytes32(agentId));
        IPolicyWallet(vault).initialize(agentId, usdc, registry, arena, score, policy);
        emit VaultDeployed(agentId, vault);
    }

    function predict(uint256 agentId) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, bytes32(agentId));
    }
}
