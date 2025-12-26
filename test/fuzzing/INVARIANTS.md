# Echidna Fuzzing Invariants Documentation

## Overview

This document describes all invariants tested in the comprehensive Echidna fuzzing test suite for the Secret Hippo Project protocol.

## What are Invariants?

Invariants are properties that must **always** be true, regardless of the sequence of operations performed on the system. They represent fundamental correctness properties of the protocol.

## Tested Invariants

### 1. Solvency Invariants

#### 1.1 Deposits Covered (`echidna_solvency_deposits_covered`)
**Property**: Contract balance ≥ sum of all user deposits

**Rationale**: The protocol must always hold enough tokens to fulfill all withdrawal requests. If this invariant is violated, users cannot retrieve their funds.

**Potential Violations**:
- Unauthorized token transfers out of contract
- Accounting errors that allow withdrawals exceeding deposits
- Reentrancy attacks that drain funds

#### 1.2 Accounting Consistency (`echidna_solvency_accounting_consistent`)
**Property**: Total staked + total in cooldown = total deposits

**Rationale**: All deposited funds must be accounted for in either the staked state or cooldown state. No tokens should be "lost" in accounting.

**Potential Violations**:
- State transition bugs between stake/cooldown/unstake
- Integer overflow/underflow in balance updates
- Missing balance updates during state changes

### 2. Math Safety Invariants

#### 2.1 Staked Amount Bounded (`echidna_math_staked_bounded`)
**Property**: Total staked ≤ token total supply

**Rationale**: It's impossible to stake more tokens than exist. This catches accounting bugs that create tokens from nothing.

**Potential Violations**:
- Overflow in staking operations
- Double-counting of stakes
- Incorrect balance updates

#### 2.2 User Stake Bounded (`echidna_math_user_stake_bounded`)
**Property**: Each user's stake ≤ total staked

**Rationale**: Individual stakes must be a subset of the total. No single user can have more staked than the entire system.

**Potential Violations**:
- Incorrect user balance updates
- Race conditions in multi-user operations
- Overflow in individual balance tracking

#### 2.3 Fee Bounded (`echidna_math_fee_bounded`)
**Property**: Call fee ≤ MAX_CALL_FEE (1%)

**Rationale**: Prevents excessive fees that could drain protocol value or make operations economically unviable.

**Potential Violations**:
- Unauthorized fee changes
- Overflow in fee calculation
- Missing validation on fee setter function

### 3. Access Control Invariants

#### 3.1 Operator Exists (`echidna_access_operator_exists`)
**Property**: Operator address ≠ 0x0

**Rationale**: The protocol must always have a valid operator for administrative functions. Losing operator control could lock the system.

**Potential Violations**:
- Bugs in operator transfer logic
- Unintended operator resignation
- Missing zero-address checks

#### 3.2 Pause State Valid (`echidna_access_pause_state_valid`)
**Property**: System pause state is a valid boolean

**Rationale**: System pause state must be deterministic and not corrupted.

**Potential Violations**:
- Storage corruption
- Uninitialized state variables

### 4. State Machine Invariants

#### 4.1 Epoch Monotonic (`echidna_state_epoch_monotonic`)
**Property**: Current epoch ≥ initial epoch (1)

**Rationale**: Time-like properties must only move forward. Epoch cannot go backward or reset unexpectedly.

**Potential Violations**:
- Underflow in epoch arithmetic
- Incorrect epoch initialization
- Unauthorized epoch manipulation

#### 4.2 Strategy Count Bounded (`echidna_state_strategy_count_bounded`)
**Property**: 1 ≤ strategy count ≤ 10

**Rationale**: System must have at least one strategy and no more than 10 to prevent gas DoS attacks in iteration.

**Potential Violations**:
- Missing bounds checks in addStrategy
- Overflow in strategy counter
- Unauthorized strategy removal

#### 4.3 System Initialized (`echidna_state_system_initialized`)
**Property**: systemInitialized = true

**Rationale**: Protocol must be properly initialized before use.

**Potential Violations**:
- Skipped initialization
- Re-initialization attacks
- Storage corruption

### 5. Economic Invariants

#### 5.1 Weights Sum Correct (`echidna_economic_weights_sum_correct`)
**Property**: Sum of user weights = DENOM (10000) or 0

**Rationale**: Weight allocation must be exactly 100% (10000 basis points). Ensures all staked value is allocated to strategies.

**Potential Violations**:
- Incorrect weight validation
- Rounding errors in weight calculation
- Concurrent weight updates

#### 5.2 Fees Reasonable (`echidna_economic_fees_reasonable`)
**Property**: Total fees collected ≥ 0

**Rationale**: Fee accounting should never be negative. Tracks that fees are properly collected.

**Potential Violations**:
- Underflow in fee calculation
- Incorrect fee distribution
- Missing fee accounting

#### 5.3 Cooldown Timing (`echidna_economic_cooldown_timing`)
**Property**: If cooldown amount > 0, then cooldown maturity ≥ current epoch

**Rationale**: Time-locked assets must respect time constraints. Users cannot unstake before maturity.

**Potential Violations**:
- Incorrect maturity calculation
- Epoch manipulation
- Missing maturity checks

### 6. Relationship Invariants

#### 6.1 Supply Stable (`echidna_relationship_supply_stable`)
**Property**: Token total supply ≥ initial supply

**Rationale**: Total supply should not decrease unexpectedly (controlled burns only).

**Potential Violations**:
- Unauthorized burns
- Supply manipulation
- Token implementation bugs

#### 6.2 Constants Immutable (`echidna_relationship_constants_immutable`)
**Property**: DENOM = 10000 AND MAX_CALL_FEE = 100

**Rationale**: System constants must never change during execution.

**Potential Violations**:
- Storage corruption
- Compiler bugs
- Malicious bytecode modification

## Test Coverage Goals

### Critical Paths (Must Cover)
1. Stake → Cooldown → Unstake flow
2. Weight setting and rebalancing
3. Multi-user concurrent operations
4. Epoch transitions
5. Fee collection and distribution
6. Admin function access control

### Edge Cases (Should Cover)
1. Maximum values (type(uint256).max)
2. Zero values
3. Single wei operations
4. Rapid epoch changes
5. Maximum strategy count
6. Concurrent same-user operations

### Attack Vectors (Must Resist)
1. Reentrancy attacks
2. Front-running scenarios
3. Integer overflow/underflow
4. Unauthorized access attempts
5. DoS through gas exhaustion
6. Economic exploits (flash loans, manipulation)

## Running the Tests

### Basic Run (1 hour)
```bash
echidna test/fuzzing/ComprehensiveFuzzTest.sol --contract ComprehensiveFuzzTest --config echidna.yaml
```

### Extended Run (24 hours)
```bash
echidna test/fuzzing/ComprehensiveFuzzTest.sol --contract ComprehensiveFuzzTest --config echidna.yaml --test-limit 10000000
```

### Coverage Analysis
```bash
echidna test/fuzzing/ComprehensiveFuzzTest.sol --contract ComprehensiveFuzzTest --config echidna.yaml --format text
```

Coverage reports will be generated in `echidna-corpus/coverage.txt`

## Interpreting Results

### Success
```
echidna_solvency_deposits_covered: passed! 🎉
```
All tests passed with the invariant holding after thousands of random operation sequences.

### Failure
```
echidna_solvency_deposits_covered: failed!💥
  Call sequence:
    stake(1000)
    enterCooldown(1000)
    unstake()
```
Invariant was violated. The call sequence shows how to reproduce the bug.

### Coverage Report
Look for:
- **Lines not covered**: Add tests targeting these paths
- **Functions never called**: May indicate dead code or missing test cases
- **Low branch coverage**: Add edge case tests

## Multi-Actor Testing

The configuration uses multiple sender addresses to simulate different users:
- `0x10000` - ADMIN (operator/manager)
- `0x20000` - USER1 (regular user)
- `0x30000` - USER2 (regular user)
- `0x40000` - MALICIOUS (potential attacker)

Echidna will randomly choose which address sends each transaction, testing for:
- Race conditions
- Access control bypasses
- Multi-user economic exploits

## Corpus Collection

Failed test sequences are saved to `echidna-corpus/` for:
1. Regression testing
2. Understanding failure patterns
3. Manual debugging
4. Improving test coverage

Rerun previous failures:
```bash
echidna test/fuzzing/ComprehensiveFuzzTest.sol --contract ComprehensiveFuzzTest --corpus-dir echidna-corpus
```

## Continuous Integration

The fuzzing tests run automatically on:
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop`

See `.github/workflows/echidna.yml` for CI configuration.

## Extending the Test Suite

To add new invariants:

1. **Identify the property**: What should always be true?
2. **Write the invariant function**: Named `echidna_category_description`
3. **Return bool**: `true` if invariant holds, `false` if violated
4. **Document it**: Add to this file with rationale and potential violations
5. **Test it**: Run fuzzing to verify it catches intended bugs

Example:
```solidity
/**
 * @notice INVARIANT: New property description
 * @dev Detailed explanation of what and why
 */
function echidna_new_invariant() public view returns (bool) {
    // Your invariant check here
    return someCondition == expectedValue;
}
```

## Acceptance Criteria Status

- ✅ At least 5 critical system invariants defined (18 implemented)
- ⏳ Fuzzing campaign runs for >1 hour without crashes (to be verified)
- ⏳ Code coverage >90% of core logic (to be measured after run)

## References

- [Echidna Documentation](https://github.com/crytic/echidna)
- [Trail of Bits Fuzzing Guide](https://blog.trailofbits.com/2018/03/09/echidna-a-smart-fuzzer-for-ethereum/)
- [Invariant Testing Best Practices](https://secure-contracts.com/program-analysis/echidna/index.html)
