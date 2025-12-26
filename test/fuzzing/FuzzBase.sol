// SPDX-License-Identifier: Open Source
pragma solidity ^0.8.30;

import "./MockERC20.sol";

/**
 * @title FuzzBase
 * @notice Base contract for Echidna fuzzing tests
 * @dev Provides common setup and utilities for fuzzing harnesses
 * 
 * This abstract contract sets up the testing environment:
 * - Mock tokens for testing
 * - Actor addresses for multi-user scenarios
 * - Helper functions for state tracking
 */
abstract contract FuzzBase {
    // ========================================================================
    // CONSTANTS
    // ========================================================================
    uint256 internal constant DENOM = 10000;
    uint256 internal constant MAX_CALL_FEE = 100;
    
    // Actor addresses for multi-user testing
    address internal constant ADMIN = address(0x10000);
    address internal constant USER1 = address(0x20000);
    address internal constant USER2 = address(0x30000);
    address internal constant MALICIOUS = address(0x40000);
    
    // ========================================================================
    // STATE VARIABLES
    // ========================================================================
    MockERC20 internal mockToken;
    
    // Track total deposits/withdrawals for solvency checks
    mapping(address => uint256) internal userDeposits;
    uint256 internal totalDeposits;
    
    // Track system state for invariant checking
    bool internal systemInitialized;
    bool internal systemPaused;
    
    // ========================================================================
    // SETUP
    // ========================================================================
    constructor() {
        // Initialize mock token with large supply
        mockToken = new MockERC20("Mock Token", "MOCK", 1000000 ether);
        
        // Distribute tokens to test actors
        mockToken.mint(ADMIN, 100000 ether);
        mockToken.mint(USER1, 100000 ether);
        mockToken.mint(USER2, 100000 ether);
        mockToken.mint(MALICIOUS, 100000 ether);
        
        systemInitialized = true;
        systemPaused = false;
    }
    
    // ========================================================================
    // HELPER FUNCTIONS
    // ========================================================================
    
    /**
     * @notice Check if caller is admin
     */
    function isAdmin(address caller) internal pure returns (bool) {
        return caller == ADMIN;
    }
    
    /**
     * @notice Check if caller is a valid user
     */
    function isValidUser(address caller) internal pure returns (bool) {
        return caller == USER1 || caller == USER2 || caller == MALICIOUS || caller == ADMIN;
    }
    
    /**
     * @notice Safe add to prevent overflow
     */
    function safeAdd(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        require(c >= a, "Addition overflow");
        return c;
    }
    
    /**
     * @notice Safe subtract to prevent underflow
     */
    function safeSub(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b <= a, "Subtraction underflow");
        return a - b;
    }
    
    // ========================================================================
    // TRACKING FUNCTIONS
    // ========================================================================
    
    /**
     * @notice Record a deposit
     */
    function recordDeposit(address user, uint256 amount) internal {
        userDeposits[user] += amount;
        totalDeposits += amount;
    }
    
    /**
     * @notice Record a withdrawal
     */
    function recordWithdrawal(address user, uint256 amount) internal {
        require(userDeposits[user] >= amount, "Insufficient user deposits");
        userDeposits[user] -= amount;
        totalDeposits -= amount;
    }
}
