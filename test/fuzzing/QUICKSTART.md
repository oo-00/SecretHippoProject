# Echidna Fuzzing Quick Start Guide

Get up and running with Echidna fuzzing tests in 5 minutes.

## Prerequisites

### 1. Install Echidna

**Option A: Using Nix (recommended)**
```bash
nix-env -i -f https://github.com/crytic/echidna/tarball/master
```

**Option B: Download Binary**
Visit [Echidna Releases](https://github.com/crytic/echidna/releases) and download for your platform.

### 2. Install Project Dependencies
```bash
npm install
```

### 3. Compile Contracts
```bash
npx hardhat compile
```

## Run Your First Test

### Quick Validation (1 minute)
```bash
./test/fuzzing/run-fuzzing.sh basic
```

This runs 1,000 sequences across both test suites to verify everything works.

**Expected Output:**
```
✅ Echidna found: echidna 2.x.x
Running BASIC fuzzing test (quick validation)...

Testing: ComprehensiveFuzzTest...
echidna_solvency_deposits_covered: passed! 🎉
echidna_solvency_accounting_consistent: passed! 🎉
echidna_math_staked_bounded: passed! 🎉
...

Testing: MagicStakerFuzzTest...
echidna_protocol_balance_composition: passed! 🎉
echidna_protocol_supply_equals_balances: passed! 🎉
...

Fuzzing test complete!
```

## Understanding the Results

### ✅ All Passed
Great! All 33 invariants held under randomized testing. Your protocol is behaving correctly.

### ❌ Test Failed
If a test fails, you'll see:
```
echidna_solvency_deposits_covered: failed!💥
  Call sequence:
    stake(1000)
    enterCooldown(500)
    unstake()
```

This shows exactly how to reproduce the bug. Debug using this sequence.

## Next Steps

### 1. Run Standard Campaign (1 hour)
```bash
./test/fuzzing/run-fuzzing.sh standard
```

More thorough testing with 50,000 sequences.

### 2. Analyze Coverage
```bash
./test/fuzzing/run-fuzzing.sh coverage
cat echidna-corpus/coverage.txt
```

See which code paths are being tested.

### 3. Run Extended Campaign (24+ hours)
```bash
# Run overnight or on a server
./test/fuzzing/run-fuzzing.sh extended
```

Deep testing with 10 million sequences for maximum confidence.

## Test Modes

| Mode | Duration | Sequences | Use Case |
|------|----------|-----------|----------|
| `basic` | ~1 min | 1,000 | Quick validation before commits |
| `standard` | ~1 hour | 50,000 | Before PRs and releases |
| `extended` | 24+ hours | 10,000,000 | Deep security testing |
| `coverage` | ~2 min | 10,000 | Coverage analysis |
| `protocol` | ~30 min | 50,000 | Protocol-specific tests only |

## What's Being Tested?

### 33 Critical Invariants

**ComprehensiveFuzzTest** (18 invariants)
- ✓ Contract solvency (balance ≥ deposits)
- ✓ Accounting consistency (staked + cooldown = deposits)
- ✓ Math safety (no overflow/underflow)
- ✓ Access control (admin functions restricted)
- ✓ State transitions (epochs advance correctly)
- ✓ Economic properties (weights, fees)

**MagicStakerFuzzTest** (15 invariants)
- ✓ Balance composition (realized + pending)
- ✓ Supply accounting (total = sum of users)
- ✓ Weight allocation (exactly 100%)
- ✓ Strategy management (bounds, immutability)
- ✓ Time constraints (epochs, cooldowns)
- ✓ Safety bounds (all values bounded)

### 4 Test Actors
- `0x10000` - ADMIN (operator/manager)
- `0x20000` - USER1 (regular user)
- `0x30000` - USER2 (regular user)
- `0x40000` - MALICIOUS (potential attacker)

Echidna randomly chooses which actor sends each transaction.

## Interpreting Coverage

After running with coverage:
```bash
./test/fuzzing/run-fuzzing.sh coverage
cat echidna-corpus/coverage.txt
```

Look for:
- **High coverage (>90%)**: Good! Most code is tested.
- **Uncovered lines**: Add targeted tests for these paths.
- **Never-called functions**: May indicate dead code or missing test scenarios.

## Troubleshooting

### "Echidna not found"
Install Echidna (see Prerequisites above).

### "Compilation failed"
```bash
npm install
npx hardhat compile
```

### "Import errors"
Check that `echidna.yaml` has correct remappings:
```yaml
cryticArgs:
  - --solc-remaps
  - "@openzeppelin=node_modules/@openzeppelin"
```

### Tests running too long
Reduce test limit in script or run basic mode:
```bash
./test/fuzzing/run-fuzzing.sh basic
```

## Files to Read

1. **QUICKSTART.md** (this file) - Get started quickly
2. **README.md** - Comprehensive usage guide
3. **INVARIANTS.md** - Detailed invariant explanations
4. **IMPLEMENTATION_SUMMARY.md** - Technical deep dive

## CI/CD Integration

Tests run automatically on:
- Push to `main` or `develop`
- Pull requests to `main` or `develop`

Check GitHub Actions for results.

## Adding Your Own Tests

1. **Open** `test/fuzzing/ComprehensiveFuzzTest.sol`
2. **Add** your invariant function:
   ```solidity
   function echidna_my_invariant() public view returns (bool) {
       return someCondition == expectedValue;
   }
   ```
3. **Document** in `INVARIANTS.md`
4. **Run** tests to verify

## Common Commands

```bash
# Quick test
./test/fuzzing/run-fuzzing.sh basic

# Standard campaign
./test/fuzzing/run-fuzzing.sh standard

# Coverage analysis
./test/fuzzing/run-fuzzing.sh coverage

# Protocol-specific only
./test/fuzzing/run-fuzzing.sh protocol

# Manual execution
echidna test/fuzzing/ComprehensiveFuzzTest.sol \
  --contract ComprehensiveFuzzTest \
  --config echidna.yaml

# View help
./test/fuzzing/run-fuzzing.sh --help
```

## Best Practices

1. **Before commits**: Run `basic` mode (~1 min)
2. **Before PRs**: Run `standard` mode (~1 hour)
3. **Before releases**: Run `extended` mode (24+ hours)
4. **Weekly**: Review corpus for interesting patterns
5. **Monthly**: Analyze coverage and improve tests

## Support

- **Documentation**: Check README.md and INVARIANTS.md
- **Issues**: Open GitHub issue with `fuzzing` label
- **Echidna Docs**: https://github.com/crytic/echidna

## Summary

You now have:
- ✅ 33 critical invariants testing your protocol
- ✅ Multi-actor testing (4 actors with random selection)
- ✅ Automated test execution (run script + CI/CD)
- ✅ Coverage analysis for finding gaps
- ✅ Corpus collection for reproducing failures

**Run your first test now:**
```bash
./test/fuzzing/run-fuzzing.sh basic
```

Happy fuzzing! 🦔
