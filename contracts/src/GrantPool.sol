// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title GrantPool
/// @notice Receives 30% of survived-session fees (value that leaves the owner's control, which makes
///         self-attack score farming unprofitable) and pays exploit discoverer bonuses.
contract GrantPool {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public admin;
    address public exploits;
    bool public wired;
    uint256 public totalBonuses;
    uint256 public totalGrants;

    event BonusPaid(address indexed to, uint128 amount);
    event GrantPaid(address indexed to, uint128 amount, string memo);

    error NotAdmin();
    error NotExploits();
    error AlreadyWired();

    constructor(address usdc_, address admin_) {
        usdc = IERC20(usdc_);
        admin = admin_;
    }

    function wire(address exploits_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (wired) revert AlreadyWired();
        wired = true;
        exploits = exploits_;
    }

    /// @notice Pays up to `amount` (capped by balance) to an exploit discoverer.
    function payBonus(address to, uint128 amount) external returns (uint128 paid) {
        if (msg.sender != exploits) revert NotExploits();
        uint256 bal = usdc.balanceOf(address(this));
        paid = amount > bal ? uint128(bal) : amount;
        if (paid > 0) {
            totalBonuses += paid;
            usdc.safeTransfer(to, paid);
            emit BonusPaid(to, paid);
        }
    }

    /// @notice Public-goods grants to red-teamers / agent builders.
    function grant(address to, uint128 amount, string calldata memo) external {
        if (msg.sender != admin) revert NotAdmin();
        totalGrants += amount;
        usdc.safeTransfer(to, amount);
        emit GrantPaid(to, amount, memo);
    }
}
