// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./ITIP20.sol";

/// @notice Non-upgradeable, single TIP-20 contractor commitment vault.
/// @dev Token issuer powers and recipient restrictions remain external risks. No worker cancellation,
/// recipient replacement, upgrade, generic call, delegatecall, or liability deletion exists.
contract SoleilVault {
    struct Claim {
        address beneficiary;
        uint256 amount;
        uint64 due;
        bool paid;
    }

    ITIP20 public immutable token;
    address public immutable employer;
    uint256 public immutable buffer;
    ISoleilStrategy public immutable strategy;
    uint256 public committed;
    bool public retired;
    mapping(bytes32 => Claim) public claims;
    uint256 private entered = 1;
    uint256 public constant MAX_BATCH = 32;

    error Unauthorized();
    error Reentrant();
    error InvalidInput();
    error InvalidRecipient();
    error Retired();
    error AlreadyConsumed();
    error UnknownClaim();
    error NotDue();
    error AlreadyPaid();
    error InsufficientCoverage();
    error IncorrectDelivery();
    error TokenCallFailed();
    error StrategyUnavailable();
    error OutstandingLiabilities();

    event Deposited(address indexed sender, uint256 amount);
    event Committed(bytes32 indexed id, address indexed beneficiary, uint256 amount, uint64 due);
    event Paid(bytes32 indexed id, address indexed beneficiary, uint256 amount);
    event SurplusWithdrawn(uint256 amount);
    event SurplusAllocated(uint256 amount);
    event StrategyRecovered(uint256 requested, uint256 received);
    event VaultRetired();

    modifier onlyEmployer() {
        if (msg.sender != employer) revert Unauthorized();
        _;
    }
    modifier nonReentrant() {
        if (entered != 1) revert Reentrant();
        entered = 2;
        _;
        entered = 1;
    }

    constructor(address token_, address employer_, uint256 buffer_, address strategy_) {
        if (token_ == address(0) || !ordinaryRecipient(employer_)) revert InvalidInput();
        if (ITIP20(token_).decimals() != 6) revert InvalidInput();
        if (strategy_ != address(0)) {
            if (strategy_.code.length == 0 || ISoleilStrategy(strategy_).asset() != token_) revert InvalidInput();
        }
        token = ITIP20(token_);
        employer = employer_;
        buffer = buffer_;
        strategy = ISoleilStrategy(strategy_);
    }

    /// @dev Reject TIP-20 contracts, virtual forwarding aliases, zero and ReceivePolicyGuard.
    /// Ordinary contract wallets are supported; code.length is not a recipient-ownership proof.
    function ordinaryRecipient(address to) public pure returns (bool) {
        uint160 value = uint160(to);
        return to != address(0)
            && to != address(0xB10C000000000000000000000000000000000000)
            && uint96(value >> 64) != 0x20c000000000000000000000
            && uint80(value >> 48) != 0xfdfdfdfdfdfdfdfdfdfd;
    }

    function liquidBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function surplus() public view returns (uint256) {
        uint256 protected = committed + (retired ? 0 : buffer);
        uint256 liquid = liquidBalance();
        return liquid > protected ? liquid - protected : 0;
    }

    /// @notice Anyone can recapitalize, including while coverage is deficient or retired.
    /// Approval must be granted by msg.sender; no employer key is needed for incoming funds.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidInput();
        uint256 beforeBalance = liquidBalance();
        uint256 senderBefore = token.balanceOf(msg.sender);
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TokenCallFailed();
        uint256 afterBalance = liquidBalance();
        uint256 senderAfter = token.balanceOf(msg.sender);
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount
            || senderAfter > senderBefore || senderBefore - senderAfter != amount) revert IncorrectDelivery();
        emit Deposited(msg.sender, amount);
    }

    function commit(bytes32 id, address beneficiary, uint256 amount, uint64 due)
        external onlyEmployer nonReentrant
    {
        _commit(id, beneficiary, amount, due);
    }

    /// @notice Atomic bounded commitments; duplicate IDs roll back the entire batch.
    function commitMany(bytes32[] calldata ids, address[] calldata beneficiaries,
        uint256[] calldata amounts, uint64[] calldata dues) external onlyEmployer nonReentrant
    {
        uint256 count = ids.length;
        if (count == 0 || count > MAX_BATCH || beneficiaries.length != count
            || amounts.length != count || dues.length != count) revert InvalidInput();
        for (uint256 i; i < count; ++i) _commit(ids[i], beneficiaries[i], amounts[i], dues[i]);
    }

    function _commit(bytes32 id, address beneficiary, uint256 amount, uint64 due) private {
        if (retired) revert Retired();
        if (id == bytes32(0) || amount == 0 || due == 0) revert InvalidInput();
        if (!ordinaryRecipient(beneficiary) || beneficiary == address(this)
            || beneficiary == address(strategy)) revert InvalidRecipient();
        if (claims[id].beneficiary != address(0)) revert AlreadyConsumed();
        uint256 newCommitted = committed + amount;
        if (liquidBalance() < newCommitted + buffer) revert InsufficientCoverage();
        claims[id] = Claim(beneficiary, amount, due, false);
        committed = newCommitted;
        emit Committed(id, beneficiary, amount, due);
    }

    /// @notice Permissionless once due. Caller pays gas or obtains independent sponsorship.
    function pay(bytes32 id) external nonReentrant { _pay(id); }

    /// @notice All-or-nothing. A restricted recipient rolls back all claims in this transaction.
    /// Each worker retains pay(id) so an unrelated failed recipient cannot block their claim.
    function payMany(bytes32[] calldata ids) external nonReentrant {
        if (ids.length == 0 || ids.length > MAX_BATCH) revert InvalidInput();
        for (uint256 i; i < ids.length; ++i) _pay(ids[i]);
    }

    function _pay(bytes32 id) private {
        Claim storage claim = claims[id];
        if (claim.beneficiary == address(0)) revert UnknownClaim();
        if (claim.paid) revert AlreadyPaid();
        if (block.timestamp < claim.due) revert NotDue();
        // Buffer deficiency does not prevent payment; principal deficiency blocks every claim.
        if (liquidBalance() < committed) revert InsufficientCoverage();
        claim.paid = true;
        committed -= claim.amount;
        _deliver(claim.beneficiary, claim.amount, id);
        emit Paid(id, claim.beneficiary, claim.amount);
    }

    function _deliver(address to, uint256 amount, bytes32 memo) private {
        uint256 sourceBefore = liquidBalance();
        uint256 recipientBefore = token.balanceOf(to);
        token.transferWithMemo(to, amount, memo);
        uint256 sourceAfter = liquidBalance();
        uint256 recipientAfter = token.balanceOf(to);
        if (sourceAfter > sourceBefore || sourceBefore - sourceAfter != amount
            || recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount) {
            // Includes native TIP-403 receive-policy redirection despite nominal transfer success.
            revert IncorrectDelivery();
        }
    }

    function withdrawSurplus(uint256 amount) external onlyEmployer nonReentrant {
        if (amount == 0 || amount > surplus()) revert InsufficientCoverage();
        _deliver(employer, amount, bytes32(0));
        if (liquidBalance() < committed + (retired ? 0 : buffer)) revert InsufficientCoverage();
        emit SurplusWithdrawn(amount);
    }

    /// @notice Optional fixed adapter. NAV, shares, pending redemption and yield never count in L.
    /// Exact short-lived allowance prevents the adapter draining already committed funds later.
    function allocateSurplus(uint256 amount) external onlyEmployer nonReentrant {
        if (retired) revert Retired();
        if (address(strategy) == address(0)) revert StrategyUnavailable();
        if (amount == 0 || amount > surplus()) revert InsufficientCoverage();
        uint256 beforeBalance = liquidBalance();
        if (!token.approve(address(strategy), amount)) revert TokenCallFailed();
        strategy.deposit(amount);
        if (!token.approve(address(strategy), 0)) revert TokenCallFailed();
        uint256 afterBalance = liquidBalance();
        if (afterBalance > beforeBalance || beforeBalance - afterBalance != amount
            || afterBalance < committed + buffer
            || token.allowance(address(this), address(strategy)) != 0) revert IncorrectDelivery();
        emit SurplusAllocated(amount);
    }

    /// @notice Pure recovery remains available during any shortfall and after retirement.
    /// No payment-asset debit is permitted, even temporarily within this operation.
    function recoverStrategy(uint256 requested, uint256 minimumReceived) external onlyEmployer nonReentrant {
        if (address(strategy) == address(0)) revert StrategyUnavailable();
        if (requested == 0) revert InvalidInput();
        uint256 beforeBalance = liquidBalance();
        strategy.withdraw(requested);
        uint256 afterBalance = liquidBalance();
        if (afterBalance < beforeBalance || afterBalance - beforeBalance < minimumReceived) revert IncorrectDelivery();
        emit StrategyRecovered(requested, afterBalance - beforeBalance);
    }

    /// @notice Permanently close commitment creation after all liabilities are settled.
    /// Tombstones remain forever. Buffer can then be withdrawn using withdrawSurplus.
    function retire() external onlyEmployer nonReentrant {
        if (retired) revert Retired();
        if (committed != 0) revert OutstandingLiabilities();
        retired = true;
        emit VaultRetired();
    }
}


