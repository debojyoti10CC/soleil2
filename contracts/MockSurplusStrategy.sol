// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ITIP20.sol";

/// @notice Explicit TEST strategy. No real yield, NAV or redemption guarantee is represented.
contract MockSurplusStrategy is ISoleilStrategy {
    address public immutable asset;
    address public immutable controller;
    mapping(address => uint256) public position;
    mapping(address => bool) public delayed;
    event SimulatedLoss(address indexed vault, uint256 amount);
    event SimulatedDelay(address indexed vault, bool value);
    constructor(address token_) { asset = token_; controller = msg.sender; }
    function deposit(uint256 amount) external {
        uint256 beforeBalance = ITIP20(asset).balanceOf(address(this));
        require(ITIP20(asset).transferFrom(msg.sender, address(this), amount), "transfer");
        require(ITIP20(asset).balanceOf(address(this)) == beforeBalance + amount, "delivery");
        position[msg.sender] += amount;
    }
    function withdraw(uint256 amount) external {
        require(!delayed[msg.sender] && position[msg.sender] >= amount, "unavailable");
        position[msg.sender] -= amount;
        ITIP20(asset).transferWithMemo(msg.sender, amount, bytes32(0));
    }
    function simulateDelay(address vault, bool value) external {
        require(msg.sender == controller, "controller");
        delayed[vault] = value; emit SimulatedDelay(vault, value);
    }
    function simulateLoss(address vault, uint256 amount) external {
        require(msg.sender == controller, "controller");
        position[vault] -= amount;
        ITIP20(asset).transferWithMemo(controller, amount, bytes32(0));
        emit SimulatedLoss(vault, amount);
    }
}

