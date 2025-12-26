# Echidna Fuzzing Test Suite

## Overview

This directory contains a comprehensive fuzzing test suite using Echidna to test critical invariants of the Secret Hippo Project protocol. The tests cover solvency, access control, state transitions, and economic properties under high-stress randomized inputs.

## Structure

```
test/fuzzing/
├── README.md                      # This file
├── INVARIANTS.md                  # Detailed invariant documentation
├── FuzzBase.sol                   # Base contract with setup and utilities
├── MockERC20.sol                  # Simple ERC20 for testing
├── ComprehensiveFuzzTest.sol      # General system invariants (18 tests)
├── MagicStakerFuzzTest.sol        # Protocol-specific invariants (15 tests)
├── run-fuzzing.sh                 # Test runner script
└── EchidnaTest.sol               # Original basic test (legacy)
```

## Quick Start

### Prerequisites

1. **Install Echidna**: Follow [installation guide](https://github.com/crytic/echidna#installation)
   ```bash
   # Linux/macOS with Nix
   nix-env -i -f https://github.com/crytic/echidna/tarball/master
   
   # Or download pre-built binary from releases
   ```

2. **Install Node dependencies** (for OpenZeppelin imports):
   ```bash
   npm install
   ```

### Running Tests

#### Basic Test Run
```bash
# Run comprehensive general invariant tests
echidna test/fuzzing/ComprehensiveFuzzTest.sol \
  --contract ComprehensiveFuzzTest \
  --config echidna.yaml

# Run protocol-specific magicStaker tests
echidna test/fuzzing/MagicStakerFuzzTest.sol \
  --contract MagicStakerFuzzTest \
  --config echidna.yaml

# Or use the provided script
./test/fuzzing/run-fuzzing.sh basic
```

#### Extended Test Run (1+ hour)
```bash
# Increase test limit for longer campaign
echidna test/fuzzing/ComprehensiveFuzzTest.sol \
  --contract ComprehensiveFuzzTest \
  --config echidna.yaml \
  --test-limit 1000000
```

#### Coverage Analysis
```bash
# Generate coverage report
echidna test/fuzzing/ComprehensiveFuzzTest.sol \
  --contract ComprehensiveFuzzTest \
  --config echidna.yaml \
  --format text

# View coverage in echidna-corpus/coverage.txt
cat echidna-corpus/coverage.txt
```

## Test Architecture

### FuzzBase.sol

Abstract base contract providing:
- Mock token setup
- Actor addresses (ADMIN, USER1, USER2, MALICIOUS)
- Helper functions for safe math and state tracking
- Deposit/withdrawal tracking for solvency checks

### ComprehensiveFuzzTest.sol

General system test contract with 18 invariants across 6 categories:

1. **Solvency (2 invariants)**
   - Contract balance covers deposits
   - Accounting consistency across states

2. **Math Safety (3 invariants)**
   - Staked amounts bounded
   - User stakes bounded
   - Fees bounded

3. **Access Control (2 invariants)**
   - Operator exists
   - Pause state valid

4. **State Machine (3 invariants)**
   - Epoch monotonic
   - Strategy count bounded
   - System initialized

5. **Economic (3 invariants)**
   - Weights sum correct
   - Fees reasonable
   - Cooldown timing valid

6. **Relationship (2 invariants)**
   - Supply stable
   - Constants immutable

### MagicStakerFuzzTest.sol

Protocol-specific test contract with 15 invariants for magicStaker:

1. **Balance composition** - realized + pending = balance
2. **Supply accounting** - total supply = sum of balances
3. **Weight allocation** - weights sum to exactly DENOM
4. **Strategy immutability** - Strategy 0 never changes
5. **Strategy bounds** - 1-10 strategies
6. **Fee limits** - Call fee ≤ MAX_CALL_FEE
7. **Constants** - DENOM and MAX_CALL_FEE immutable
8. **Epoch monotonicity** - Epochs advance forward
9. **Voting power** - Never exceeds total supply
10. **Cooldown timing** - Respects maturity constraints
11. **Supply solvency** - Contract holds ≥ totalSupply
12. **Realized bounds** - Realized stake ≤ totalSupply
13. **Pending bounds** - Pending stake ≤ totalSupply
14. **Update epoch** - Last update never in future

### Multi-Actor Testing

Tests simulate 4 different actors:
- `0x10000` - ADMIN (operator/manager)
- `0x20000` - USER1 (regular user)
- `0x30000` - USER2 (regular user)
- `0x40000` - MALICIOUS (potential attacker)

Echidna randomly selects which actor sends each transaction, testing:
- Concurrent operations
- Access control
- Race conditions
- Multi-user exploits

## Configuration (echidna.yaml)

Key settings:
- **testLimit**: 50,000 sequences (increase for longer runs)
- **seqLen**: 100 transactions per sequence
- **coverage**: Enabled for coverage analysis
- **corpus**: Saved to `echidna-corpus/` for replay
- **sender**: Multiple addresses for multi-actor testing

## Interpreting Results

### Passing Tests ✅
```
echidna_solvency_deposits_covered: passed! 🎉
echidna_math_staked_bounded: passed! 🎉
...
```
All invariants held after thousands of random operation sequences.

### Failing Tests ❌
```
echidna_solvency_deposits_covered: failed!💥
  Call sequence:
    stake(1000)
    enterCooldown(1000)
    unstake()
    [Additional calls...]
```

When a test fails:
1. **Review the call sequence**: Exact steps to reproduce
2. **Check the invariant**: What property was violated?
3. **Analyze the state**: Use the sequence to debug
4. **Fix the bug**: Update contract logic
5. **Re-run**: Verify fix prevents the failure

### Coverage Analysis

After running with coverage enabled:
```bash
cat echidna-corpus/coverage.txt
```

Look for:
- **Uncovered lines**: Add focused tests
- **Low branch coverage**: Add edge cases
- **Never-called functions**: Dead code or missing tests

## CI Integration

Fuzzing tests run automatically on:
- Pushes to `main` or `develop`
- Pull requests to `main` or `develop`

Workflow: `.github/workflows/echidna.yml`

Results are uploaded as artifacts for review.

## Adding New Invariants

To add a new invariant:

1. **Identify the property**: What should always be true?

2. **Add to ComprehensiveFuzzTest.sol**:
   ```solidity
   /**
    * @notice INVARIANT: Description
    * @dev Detailed explanation
    */
   function echidna_category_name() public view returns (bool) {
       // Check your invariant
       return someCondition == expectedValue;
   }
   ```

3. **Document in INVARIANTS.md**:
   - Property description
   - Rationale
   - Potential violations

4. **Test**:
   ```bash
   echidna test/fuzzing/ComprehensiveFuzzTest.sol \
     --contract ComprehensiveFuzzTest \
     --config echidna.yaml
   ```

## Best Practices

### Writing Invariants
- **Keep them simple**: One property per invariant
- **Make them fast**: Called thousands of times
- **Return bool**: `true` = pass, `false` = fail
- **Use view**: No state changes in invariant checks
- **Document thoroughly**: Explain what and why

### State Mutations
- **Bound inputs**: Prevent unrealistic values
- **Handle failures**: Return early on invalid inputs
- **Maintain invariants**: Never violate your own invariants
- **Test edge cases**: Zero, max, boundaries

### Performance
- **Minimize gas**: Invariants run frequently
- **Avoid loops**: Or bound loop iterations
- **Cache values**: Store computations if reused
- **Optimize checks**: Most expensive checks last

## Troubleshooting

### Echidna Not Found
```bash
# Install via Nix
nix-env -i -f https://github.com/crytic/echidna/tarball/master

# Or download binary
# https://github.com/crytic/echidna/releases
```

### Compilation Errors
```bash
# Ensure dependencies installed
npm install

# Try with explicit solc version
echidna ... --solc-version 0.8.30
```

### Import Errors
```bash
# Check remappings in echidna.yaml
cryticArgs:
  - --solc-remaps
  - "@openzeppelin=node_modules/@openzeppelin"
```

### Timeout Issues
```bash
# Increase timeout in echidna.yaml
timeout: 600  # 10 minutes
```

## Resources

- [Echidna Documentation](https://github.com/crytic/echidna)
- [Fuzzing Tutorial](https://github.com/crytic/building-secure-contracts/tree/master/program-analysis/echidna)
- [Trail of Bits Blog](https://blog.trailofbits.com/)
- [INVARIANTS.md](./INVARIANTS.md) - Detailed invariant documentation

## Maintenance

### Regular Tasks
1. **Update invariants**: As protocol evolves
2. **Review corpus**: Learn from failures
3. **Analyze coverage**: Improve test coverage
4. **Run extended campaigns**: Periodic deep testing
5. **Update documentation**: Keep in sync with code

### When to Run
- **Before major releases**: Extended campaign
- **After protocol changes**: Verify invariants still hold
- **When adding features**: Add relevant invariants
- **Security audits**: Provide fuzzing results

## Acceptance Criteria

This test suite meets the following criteria:

✅ **5+ Critical Invariants**: 33 total invariants implemented
- ComprehensiveFuzzTest: 18 general system invariants
  - Solvency: 2
  - Math Safety: 3
  - Access Control: 2
  - State Machine: 3
  - Economic: 3
  - Relationship: 2
  - Additional: 3
- MagicStakerFuzzTest: 15 protocol-specific invariants
  - Balance & Supply: 3
  - Weights & Strategies: 3
  - Access & Constants: 2
  - Time & State: 4
  - Bounds & Safety: 3

⏳ **1+ Hour Campaign**: Ready to run (command provided)

⏳ **90%+ Coverage**: Measurable after extended run

## Contact

For questions or issues with the fuzzing test suite, please:
1. Check existing documentation
2. Review INVARIANTS.md for details
3. Open an issue with reproduction steps
4. Tag with `fuzzing` label
