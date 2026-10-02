// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ITIP20.sol";

/// @notice TEST ONLY. Models strict token denial, nominal-success redirection, pause, issuer loss,
/// transfer fee and hostile callbacks. This is not a Tempo precompile or real stablecoin.
contract MockTIP20 is ITIP20 {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;
    mapping(address => bool) public redirected;
    bool public paused;
    bool public feeEnabled;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackMustSucceed;
    address public constant GUARD = address(0xB10C000000000000000000000000000000000000);
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo);

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function slash(address from, uint256 amount) external { balanceOf[from] -= amount; }
    function setBlocked(address account, bool value) external { blocked[account] = value; }
    function setRedirected(address account, bool value) external { redirected[account] = value; }
    function setPaused(bool value) external { paused = value; }
    function setFeeEnabled(bool value) external { feeEnabled = value; }
    function setCallback(address target, bytes calldata data, bool mustSucceed) external {
        callbackTarget = target; callbackData = data; callbackMustSucceed = mustSucceed;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "allowance");
        allowance[from][msg.sender] = approved - amount;
        _transfer(from, to, amount, bytes32(0)); return true;
    }
    function transferWithMemo(address to, uint256 amount, bytes32 memo) external {
        _transfer(msg.sender, to, amount, memo);
    }
    function _transfer(address from, address to, uint256 amount, bytes32 memo) private {
        require(!paused && !blocked[from] && !blocked[to], "restricted");
        balanceOf[from] -= amount;
        address actualTo = redirected[to] ? GUARD : to;
        balanceOf[actualTo] += feeEnabled && amount != 0 ? amount - 1 : amount;
        emit Transfer(from, actualTo, amount);
        emit TransferWithMemo(from, actualTo, amount, memo);
        if (callbackTarget != address(0)) {
            (bool success,) = callbackTarget.call(callbackData);
            require(!callbackMustSucceed || success, "callback");
        }
    }
}

