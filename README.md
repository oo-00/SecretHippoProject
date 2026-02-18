# SecretHippoProject

[![Hound Security Audit](https://img.shields.io/badge/Audited_by-Hound-dc3545?style=flat-square&logo=security&logoColor=white)](hippofinal_security_report.html)

2nd layer Stake RSUP

Can support multiple strategies, with initial two planned for compounding RSUP, and for sreusd (as opposed to current reUSD only)

Non-transferable / Not a token. Staker dictates balances of strategies.

### To do

- UI

### Protections in place:

Since voting power is not tracked 1:1 with Resupply, significantly increasing ones stake incurs a vote delay.

Requires a local quorum of 20% in order to commit vote to Resupply

Since there may be small rounding issues from staker dictating strategy balances, weights can only be changed once per epoch.

## Echidna Fuzzing

This project includes [Echidna](https://github.com/crytic/echidna) fuzzing tests for automated security testing and vulnerability detection.

### Running Echidna Locally

#### Prerequisites
- Install Echidna: Follow instructions at https://github.com/crytic/echidna#installation
- Or use Docker: `docker pull trailofbits/eth-security-toolbox`

#### Run Fuzzing Tests
```bash
# Using local Echidna installation
echidna . --contract EchidnaTest --config echidna.yaml

# Using Docker
docker run -it -v $(pwd):/src trailofbits/eth-security-toolbox
cd /src
echidna . --contract EchidnaTest --config echidna.yaml
```

#### Configuration
- Configuration file: `echidna.yaml`
- Test harness: `test/fuzzing/EchidnaTest.sol`
- Corpus directory: `echidna-corpus/` (gitignored)

#### Test Parameters
- **testMode**: assertion - Tests invariants defined in the harness
- **testLimit**: 50,000 transaction sequences
- **seqLen**: 100 max transactions per sequence
- **timeout**: 300 seconds per test

### CI/CD Integration

Echidna runs automatically on every push and pull request via GitHub Actions (`.github/workflows/echidna.yml`). Results are uploaded as artifacts for review.

### Fuzzing Invariants

The `EchidnaTest` harness validates critical system invariants:
- Balance and supply values remain non-negative after any operation
- Arithmetic operations (add/subtract) maintain overflow/underflow protection
- Contract balance is always non-negative
- Protocol constants maintain expected values (DENOM = 10000, MAX_CALL_FEE = 100)

The test harness includes state mutation functions that Echidna uses to explore the state space:
- `addBalance()` / `subBalance()` - Simulate balance changes with overflow protection
- `addSupply()` / `subSupply()` - Simulate supply changes with underflow protection

For more details and to add contract-specific invariants, see `test/fuzzing/EchidnaTest.sol`.