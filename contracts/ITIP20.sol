// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Relevant native TIP-20 ABI. transferWithMemo deliberately has NO return value.
interface ITIP20 {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transferWithMemo(address to, uint256 amount, bytes32 memo) external;
}

interface ISoleilStrategy {
    function asset() external view returns (address);
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
}

