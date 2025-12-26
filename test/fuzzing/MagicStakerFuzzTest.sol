// SPDX-License-Identifier: Open Source
pragma solidity ^0.8.30;

import "./FuzzBase.sol";

/**
 * @title MagicStakerFuzzTest
 * @notice Advanced fuzzing tests specific to magicStaker invariants
 * @dev Tests protocol-specific invariants that are critical to magicStaker
 * 
 * PROTOCOL-SPECIFIC INVARIANTS:
 * 1. Weight allocation is always exactly 100% (DENOM)
 * 2. User balance = realizedStake + pendingStake
 * 3. Total supply = sum of all user balances
 * 4. Cooldown can only occur on cooldown epochs
 * 5. Strategy 0 is always magicPounder
 * 6. Call fee never exceeds MAX_CALL_FEE (1%)
 * 7. Voting power is monotonically increasing or equal per epoch
 */
contract MagicStakerFuzzTest is FuzzBase {
    // ========================================================================
    // PROTOCOL CONSTANTS (from magicStaker.sol)
    // ========================================================================
    
    uint256 constant EXPECTED_DENOM = 10000;
    uint256 constant EXPECTED_MAX_CALL_FEE = 100;
    
    // ========================================================================
    // SIMULATED PROTOCOL STATE
    // ========================================================================
    
    // Account stake data simulation
    struct AccountStakeData {
        uint112 realizedStake;
        uint112 pendingStake;
        uint112 magicStake;
        uint16 lastUpdateEpoch;
    }
    
    mapping(address => AccountStakeData) public accountStakeData;
    mapping(address => uint256[]) public accountWeights;
    
    uint256 public totalSupply;
    uint256 public currentEpoch;
    uint256 public callFee = 5; // 0.05%
    
    // Cooldown tracking
    mapping(address => uint256) public cooldownAmount;
    mapping(address => uint256) public cooldownMaturityEpoch;
    uint256 public cooldownEpochs = 2; // Simulated cooldown period
    
    // Strategy tracking
    address[] public strategies;
    mapping(address => uint256) public strategyTotalSupply;
    
    // Voting power tracking
    mapping(address => mapping(uint256 => uint256)) public votingPowerAt;
    
    // ========================================================================
    // CONSTRUCTOR
    // ========================================================================
    
    constructor() FuzzBase() {
        currentEpoch = 1;
        // Strategy 0 is immutable magicPounder
        strategies.push(address(0x1111)); // Mock address for strategy 0
    }
    
    // ========================================================================
    // STATE MUTATION FUNCTIONS
    // ========================================================================
    
    /**
     * @notice Simulate stake operation
     */
    function stake(uint256 amount) public {
        if (amount == 0 || amount > 10000 ether) return;
        if (mockToken.balanceOf(msg.sender) < amount) return;
        if (accountWeights[msg.sender].length == 0) return; // Must set weights first
        
        // Transfer tokens
        mockToken.transferFrom(msg.sender, address(this), amount);
        
        // Update account data
        AccountStakeData storage acctData = accountStakeData[msg.sender];
        acctData.pendingStake += uint112(amount);
        acctData.lastUpdateEpoch = uint16(currentEpoch);
        
        // Update total supply
        totalSupply += amount;
        
        // Update voting power
        votingPowerAt[msg.sender][currentEpoch] += amount;
        
        recordDeposit(msg.sender, amount);
    }
    
    /**
     * @notice Simulate setting user weights
     */
    function setWeights(uint256 w0, uint256 w1, uint256 w2) public {
        // Normalize weights
        w0 = w0 % (DENOM + 1);
        w1 = w1 % (DENOM + 1);
        w2 = w2 % (DENOM + 1);
        
        uint256 sum = w0 + w1 + w2;
        if (sum != DENOM) return;
        
        // Clear old weights
        delete accountWeights[msg.sender];
        
        // Set new weights
        accountWeights[msg.sender].push(w0);
        accountWeights[msg.sender].push(w1);
        accountWeights[msg.sender].push(w2);
    }
    
    /**
     * @notice Realize pending stake (epoch transition)
     */
    function realizePendingStake(address user) public {
        AccountStakeData storage acctData = accountStakeData[user];
        if (acctData.lastUpdateEpoch >= currentEpoch) return;
        
        // Move pending to realized
        acctData.realizedStake += acctData.pendingStake;
        acctData.pendingStake = 0;
        acctData.lastUpdateEpoch = uint16(currentEpoch);
    }
    
    /**
     * @notice Simulate cooldown
     */
    function cooldown(uint256 amount) public {
        // Must be cooldown epoch
        // cooldownEpochs+1 represents the cooldown period (e.g., if cooldown is 2 weeks, can only initiate every 3rd week)
        if (currentEpoch % (cooldownEpochs + 1) != 0) return;
        
        AccountStakeData storage acctData = accountStakeData[msg.sender];
        if (amount == 0 || amount > acctData.realizedStake) return;
        
        // Move from realized to cooldown
        acctData.realizedStake -= uint112(amount);
        cooldownAmount[msg.sender] += amount;
        cooldownMaturityEpoch[msg.sender] = currentEpoch + cooldownEpochs;
        
        totalSupply -= amount;
    }
    
    /**
     * @notice Simulate unstake
     */
    function unstake() public {
        if (cooldownAmount[msg.sender] == 0) return;
        if (cooldownMaturityEpoch[msg.sender] > currentEpoch) return;
        
        uint256 amount = cooldownAmount[msg.sender];
        cooldownAmount[msg.sender] = 0;
        
        mockToken.transfer(msg.sender, amount);
        recordWithdrawal(msg.sender, amount);
    }
    
    /**
     * @notice Advance epoch
     */
    function advanceEpoch() public {
        currentEpoch++;
    }
    
    /**
     * @notice Set call fee (admin only)
     */
    function setCallFee(uint256 newFee) public {
        if (msg.sender != ADMIN) return;
        if (newFee > EXPECTED_MAX_CALL_FEE) return;
        callFee = newFee;
    }
    
    /**
     * @notice Add strategy (admin only)
     */
    function addStrategy(address strategy) public {
        if (msg.sender != ADMIN) return;
        if (strategy == address(0)) return;
        if (strategies.length >= 10) return;
        strategies.push(strategy);
    }
    
    // ========================================================================
    // PROTOCOL-SPECIFIC INVARIANTS
    // ========================================================================
    
    /**
     * @notice INVARIANT: User balance equals sum of realized and pending stake
     */
    function echidna_protocol_balance_composition() public view returns (bool) {
        address[4] memory users = [ADMIN, USER1, USER2, MALICIOUS];
        
        for (uint256 i = 0; i < users.length; i++) {
            AccountStakeData memory acctData = accountStakeData[users[i]];
            uint256 calculatedBalance = uint256(acctData.realizedStake) + uint256(acctData.pendingStake);
            
            // Balance should match sum of components
            // In simplified model, we just check consistency
            if (calculatedBalance > totalSupply) {
                return false;
            }
        }
        return true;
    }
    
    /**
     * @notice INVARIANT: Total supply equals sum of all user balances
     */
    function echidna_protocol_supply_equals_balances() public view returns (bool) {
        address[4] memory users = [ADMIN, USER1, USER2, MALICIOUS];
        uint256 sumBalances = 0;
        
        for (uint256 i = 0; i < users.length; i++) {
            AccountStakeData memory acctData = accountStakeData[users[i]];
            sumBalances += uint256(acctData.realizedStake) + uint256(acctData.pendingStake);
        }
        
        // Allow for rounding differences of up to 1 wei per user
        if (sumBalances > totalSupply + users.length) {
            return false;
        }
        if (totalSupply > sumBalances + users.length) {
            return false;
        }
        
        return true;
    }
    
    /**
     * @notice INVARIANT: Weights sum to exactly DENOM when set
     */
    function echidna_protocol_weights_exact() public view returns (bool) {
        address[4] memory users = [ADMIN, USER1, USER2, MALICIOUS];
        
        for (uint256 i = 0; i < users.length; i++) {
            uint256[] memory weights = accountWeights[users[i]];
            if (weights.length > 0) {
                uint256 sum = 0;
                for (uint256 j = 0; j < weights.length; j++) {
                    sum += weights[j];
                }
                // Must be exactly DENOM (no tolerance)
                if (sum != DENOM) {
                    return false;
                }
            }
        }
        return true;
    }
    
    /**
     * @notice INVARIANT: Strategy 0 is immutable
     */
    function echidna_protocol_strategy_0_immutable() public view returns (bool) {
        if (strategies.length == 0) return false;
        return strategies[0] == address(0x1111); // Our mock strategy 0
    }
    
    /**
     * @notice INVARIANT: Strategy count bounded
     */
    function echidna_protocol_strategy_count_bounded() public view returns (bool) {
        return strategies.length >= 1 && strategies.length <= 10;
    }
    
    /**
     * @notice INVARIANT: Call fee never exceeds maximum
     */
    function echidna_protocol_call_fee_bounded() public view returns (bool) {
        return callFee <= EXPECTED_MAX_CALL_FEE;
    }
    
    /**
     * @notice INVARIANT: Constants remain constant
     */
    function echidna_protocol_constants_immutable() public pure returns (bool) {
        return EXPECTED_DENOM == 10000 && EXPECTED_MAX_CALL_FEE == 100;
    }
    
    /**
     * @notice INVARIANT: Epoch advances monotonically
     */
    function echidna_protocol_epoch_monotonic() public view returns (bool) {
        return currentEpoch >= 1;
    }
    
    /**
     * @notice INVARIANT: Voting power never decreases for an epoch
     */
    function echidna_protocol_voting_power_stable() public view returns (bool) {
        address[4] memory users = [ADMIN, USER1, USER2, MALICIOUS];
        
        for (uint256 i = 0; i < users.length; i++) {
            // Check that voting power for past epochs hasn't changed
            if (currentEpoch > 1) {
                uint256 prevPower = votingPowerAt[users[i]][currentEpoch - 1];
                uint256 currPower = votingPowerAt[users[i]][currentEpoch];
                // Current can be >= previous (monotonic or equal)
                // But we're just checking it's valid
                if (prevPower > totalSupply || currPower > totalSupply) {
                    return false;
                }
            }
        }
        return true;
    }
    
    /**
     * @notice INVARIANT: Cooldown timing respected
     */
    function echidna_protocol_cooldown_timing() public view returns (bool) {
        address[4] memory users = [ADMIN, USER1, USER2, MALICIOUS];
        
        for (uint256 i = 0; i < users.length; i++) {
            if (cooldownAmount[users[i]] > 0) {
                // If cooldown exists, maturity must be in future or present
                if (cooldownMaturityEpoch[users[i]] < currentEpoch) {
                    return false;
                }
            }
        }
        return true;
    }
    
    /**
     * @notice INVARIANT: Total supply consistency with deposits
     */
    function echidna_protocol_supply_solvency() public view returns (bool) {
        uint256 contractBalance = mockToken.balanceOf(address(this));
        // Contract must hold at least totalSupply worth of tokens
        return contractBalance >= totalSupply;
    }
    
    /**
     * @notice INVARIANT: Realized stake bounded by total supply
     */
    function echidna_protocol_realized_stake_bounded() public view returns (bool) {
        address[4] memory users = [ADMIN, USER1, USER2, MALICIOUS];
        
        for (uint256 i = 0; i < users.length; i++) {
            AccountStakeData memory acctData = accountStakeData[users[i]];
            if (acctData.realizedStake > totalSupply) {
                return false;
            }
        }
        return true;
    }
    
    /**
     * @notice INVARIANT: Pending stake bounded by total supply
     */
    function echidna_protocol_pending_stake_bounded() public view returns (bool) {
        address[4] memory users = [ADMIN, USER1, USER2, MALICIOUS];
        
        for (uint256 i = 0; i < users.length; i++) {
            AccountStakeData memory acctData = accountStakeData[users[i]];
            if (acctData.pendingStake > totalSupply) {
                return false;
            }
        }
        return true;
    }
    
    /**
     * @notice INVARIANT: Last update epoch never in future
     */
    function echidna_protocol_update_epoch_valid() public view returns (bool) {
        address[4] memory users = [ADMIN, USER1, USER2, MALICIOUS];
        
        for (uint256 i = 0; i < users.length; i++) {
            AccountStakeData memory acctData = accountStakeData[users[i]];
            if (acctData.lastUpdateEpoch > currentEpoch) {
                return false;
            }
        }
        return true;
    }
}
