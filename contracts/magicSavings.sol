// SPDX-License-Identifier: MIT

//  You should personally audit and test this code before using it.

pragma solidity ^0.8.30;

import { IERC20, SafeERC20 } from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import { OperatorManager } from "./operatorManager.sol";

interface MagicStaker {
    function strategyHarvester(address strategy) external returns (address);
}

contract magicSavings is OperatorManager {
    using SafeERC20 for IERC20;
    IERC20 public constant rewardToken = IERC20(0x557AB1e003951A73c12D16F0fEA8490E39C33C35);
    address public constant desiredToken = 0x557AB1e003951A73c12D16F0fEA8490E39C33C35;
    address public immutable magicStaker;

    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    uint256 private constant MULTIPLIER = 1e18;
    uint256 private rewardIndex;
    mapping(address => uint256) private rewardIndexOf;
    mapping(address => uint256) private earned;

    event Executed(address to, uint256 value, bytes data, bool success);
    event Claimed(address indexed user, uint256 amount);
    event RewardNotified(uint256 amount);
    event NewBalance(address indexed user, uint256 balance);

    constructor(address _magicStaker, address _operator, address _manager) OperatorManager(_operator, _manager) {
        require(_magicStaker != address(0), "!zeroAddress");
        magicStaker = _magicStaker;
    }

    modifier onlyMagicStaker {
        require(msg.sender == magicStaker, "!auth");
        _;
    }

    function notifyReward(uint256 _amount) external {
        require(msg.sender == MagicStaker(magicStaker).strategyHarvester(address(this)));
        rewardToken.safeTransferFrom(msg.sender, address(this), _amount);
        rewardIndex += (_amount * MULTIPLIER) / totalSupply;
        emit RewardNotified(_amount);
    }

    function setUserBalance(address _account, uint256 _balance) external onlyMagicStaker {
        require(_account != address(0), "!account");
        _updateRewards(_account);

        uint256 userBalance = balanceOf[_account];
        emit NewBalance(_account, _balance);
        if(_balance == 0) {
            totalSupply -= userBalance;
            balanceOf[_account] = 0;
            return;
        }
        if(_balance > userBalance) {
            uint256 diff = _balance - userBalance;
            totalSupply += diff;
            balanceOf[_account] = _balance;
            return;
        }
        if(userBalance > _balance) {
            uint256 diff = userBalance - _balance;
            totalSupply -= diff;
            balanceOf[_account] = _balance;
            return;
        }
    }

    function _calculateRewards(address account)
        private
        view
        returns (uint256)
    {
        uint256 shares = balanceOf[account];
        return (shares * (rewardIndex - rewardIndexOf[account])) / MULTIPLIER;
    }

    function claimable(address account)
        external
        view
        returns (uint256)
    {
        return earned[account] + _calculateRewards(account);
    }

    function _updateRewards(address account) private {
        earned[account] += _calculateRewards(account);
        rewardIndexOf[account] = rewardIndex;
    }

    function claim() external returns (uint256) {
        _updateRewards(msg.sender);

        uint256 reward = earned[msg.sender];
        if (reward > 0) {
            earned[msg.sender] = 0;
            rewardToken.safeTransfer(msg.sender, reward);
        }
        emit Claimed(msg.sender, reward);
        return reward;
    }
    // Fallback executable function
    function execute(
        address _to,
        uint256 _value,
        bytes calldata _data
    ) external onlyOperator returns (bool, bytes memory) {
        require(msg.sender == RESUPPLY_CORE, "!auth");
        (bool success, bytes memory result) = _to.call{value: _value}(_data);
        emit Executed(_to, _value, _data, success);
        return (success, result);
    }
}