// SPDX-License-Identifier: Open Source

//  You should personally audit and test this code before using it.

pragma solidity ^0.8.30;

import { IERC20, SafeERC20 } from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import { OperatorManager } from "./operatorManager.sol";

interface MagicStaker {
    function magicStake(uint256 _amount) external;
    function strategyHarvester(address strategy) external returns (address);
}

contract magicPounder is OperatorManager {
    using SafeERC20 for IERC20;
    address public constant desiredToken = 0x419905009e4656fdC02418C7Df35B1E61Ed5F726;
    address public magicStaker;
    uint256 public sharesTotalSupply;
    uint256 public totalSupply;
    // user shares - balanceOf is reserved for underlying balance for magicStaker interoperability
    mapping(address account => uint256) public sharesOf;

    event Executed(address to, uint256 value, bytes data, bool success);
    event RewardNotified(uint256 amount);
    event NewBalance(address indexed user, uint256 balance, uint256 shares);

    constructor (address _operator, address _manager) OperatorManager(_operator, _manager) {}

    modifier onlyMagicStaker {
        require(msg.sender == magicStaker, "!auth");
        _;
    }

    function balanceOf(address user) public view returns (uint256 amount) {
        if(sharesTotalSupply == 0) {
            return 0;
        }
        return ((sharesOf[user] * totalSupply) / sharesTotalSupply);
    }
    
    function underlyingToShares(uint256 _amount) public view returns (uint256) {
        if(sharesTotalSupply == 0 || totalSupply == 0) {
            return _amount;
        }
        return (_amount * sharesTotalSupply) / totalSupply;
    }

    function setUserBalance(address _account, uint256 _balance) external onlyMagicStaker {
        require(_account != address(0), "!account");
        uint256 userBalance = balanceOf(_account);
        if(_balance == 0) {
            totalSupply -= userBalance;
            sharesTotalSupply -= sharesOf[_account];
            sharesOf[_account] = 0;
            emit NewBalance(_account, 0, 0);
            return;
        }
        uint256 oldShares = sharesOf[_account];
        if(_balance != userBalance) {
            uint256 newShares = underlyingToShares(_balance);
            if(newShares < oldShares) {
                sharesTotalSupply -= oldShares - newShares;
            } else {
                sharesTotalSupply += newShares - oldShares;
            }
            sharesOf[_account] = newShares;
            totalSupply = totalSupply - userBalance + _balance;
            emit NewBalance(_account, _balance, newShares);
        } else {
            emit NewBalance(_account, _balance, oldShares);
        }
        assert(sharesOf[_account] <= sharesTotalSupply);
        assert(totalSupply > 0);
        assert(sharesTotalSupply > 0);
    }

    function notifyReward(uint256 _amount) external {
        require(msg.sender == MagicStaker(magicStaker).strategyHarvester(address(this)));
        IERC20(desiredToken).safeTransferFrom(msg.sender, address(this), _amount);
        // magic stake RSUP
        MagicStaker(magicStaker).magicStake(_amount);
        totalSupply += _amount;
        emit RewardNotified(_amount);
    }

    // needs to be immutable since this contract handles balances
    function setMagicStaker(address _magicStaker) external onlyOperator {
        require(magicStaker == address(0), "!immutable");
        require(_magicStaker != address(0), "!zero");
        magicStaker = _magicStaker;
        IERC20(desiredToken).approve(magicStaker, type(uint256).max);
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