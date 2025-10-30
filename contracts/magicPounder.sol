// SPDX-License-Identifier: Open Source

/*
    This is not audited. 
    This is not tested. 
    You should personally audit and test this code before using it.

*/ 

pragma solidity ^0.8.30;

import { IERC20, SafeERC20 } from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import { OperatorManager } from "./operatorManager.sol";

interface MagicStaker {
    function magicStake(uint256 _amount) external;
}

contract magicPounder is OperatorManager {
    using SafeERC20 for IERC20;
    address public constant desiredToken = 0x419905009e4656fdC02418C7Df35B1E61Ed5F726;
    address public magicStaker;
    uint256 public totalSupply;
    uint256 public underlyingTotalSupply;
    // user shares - balanceOf is reserved for underlying balance for magicStaker interoperability
    mapping(address account => uint256) public sharesOf;

    constructor (address _operator, address _manager) OperatorManager(_operator, _manager) {}

    modifier onlyMagicStaker {
        require(msg.sender == magicStaker, "!auth");
        _;
    }

    function balanceOf(address user) public view returns (uint256 amount) {
        if(totalSupply == 0) {
            return 0;
        }
        return ((sharesOf[user] * underlyingTotalSupply) / totalSupply);
    }
    
    function underlyingToShares(uint256 _amount) public view returns (uint256) {
        if(totalSupply == 0) {
            return _amount;
        }
        require(_amount * totalSupply >= underlyingTotalSupply, "!small");
        return (_amount * totalSupply) / underlyingTotalSupply;
    }

    function setUserBalance(address _account, uint256 _balance) external onlyMagicStaker {
        uint256 userBalance = balanceOf(_account);
        if(_balance == 0) {
            underlyingTotalSupply -= userBalance;
            totalSupply -= sharesOf[_account];
            sharesOf[_account] = 0;
            return;
        }
        if(_balance < userBalance) {
            uint256 diff = userBalance - _balance;
            uint256 removeShares = underlyingToShares(diff);
            sharesOf[_account] -= removeShares;
            totalSupply -= removeShares;
            underlyingTotalSupply -= diff;
            return;
        }
        if(_balance > userBalance) {
            uint256 diff = _balance - userBalance;
            uint256 addShares = underlyingToShares(diff);
            sharesOf[_account] += addShares;
            totalSupply += addShares;
            underlyingTotalSupply += diff;
            return;
        }
    }

    function notifyReward(uint256 _amount) external onlyMagicStaker {
        // magic stake RSUP
        MagicStaker(magicStaker).magicStake(_amount);
        underlyingTotalSupply += _amount;
    }

    // needs to be immutable since this contract handles balances
    function setMagicStaker(address _magicStaker) external onlyOperator {
        require(_magicStaker != address(0), "!zero");
        magicStaker = _magicStaker;
        IERC20(desiredToken).approve(magicStaker, type(uint256).max);
    }
}