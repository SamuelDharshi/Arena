// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AgentStatus, Policy} from "../libs/Types.sol";

interface IAgentRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function signerOf(uint256 agentId) external view returns (address);
    function vaultOf(uint256 agentId) external view returns (address);
    function statusOf(uint256 agentId) external view returns (AgentStatus);
    function allowlistRootOf(uint256 agentId) external view returns (bytes32);
    function agentCount() external view returns (uint256);
    function setStatus(uint256 agentId, AgentStatus s) external;
}

interface IPolicyWallet {
    function initialize(
        uint256 agentId,
        address usdc,
        address registry,
        address arena,
        address score,
        Policy calldata policy
    ) external;
    function lock(uint128 amount) external;
    function unlock(uint128 amount) external;
    function creditBounty(uint128 amount) external;
    function freeBounty() external view returns (uint128);
}

interface IArenaCore {
    function liveSessionOf(uint256 agentId, address attacker) external view returns (uint256);
    function onBreach(uint256 sid, uint128 requested) external returns (uint128 payout, uint128 locked);
    function tierBountyOf(uint8 tier) external view returns (uint128);
    function gatewayAttestor() external view returns (address);
}

interface IScoreRegistry {
    function credit(uint256 agentId, address attacker, uint8 tier, uint32 msgCount) external;
    function onBreach(uint256 agentId, address attacker, uint8 tier) external;
    function onConfigChange(uint256 agentId) external;
    function addGauntletPending(uint256 agentId, uint64 deadline) external;
    function resolveGauntletPending(uint256 agentId) external;
    function onGauntletFail(uint256 agentId) external;
    function effectiveTier(uint256 agentId) external view returns (uint8);
    function dailyLimit(uint256 agentId) external view returns (uint128);
}

interface IGrantPool {
    function payBonus(address to, uint128 amount) external returns (uint128 paid);
}
