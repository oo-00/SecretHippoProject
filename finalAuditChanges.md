Special thanks to Gemach team for valuable insights! 

# High Severity

## Harvest DoS: zero per-strategy share causes magicHarvester.process to revert

Added checks in magicHarvester to avoid _process and notifyReward calls when rewards are 0

## Reward misallocation: totalSupply changes mid-harvest via reentrant magicStake

Added static totalSupply check outside of strategy loop in magicStaker

## Harvester credits full tokenOut balance instead of delta, enabling cross-strategy reward leakage

Added delta calculation

## Route testing in setRoute can sweep all existing tokenOut from harvester to operator (no delta accounting)

Added delta calculation

## Deflationary/fee-on-transfer reward tokens inflate rewardIndex causing insolvency and claim DoS

Acceptable for current strategies, which are limited to RSUP and sreUSD tokens, which have no fee-on-transfer

## Unchecked Registry.getAddress result can set zero/EOA/malicious Voter, bricking or hijacking governance

Added zero-address and contract code checks in isValidVoter()

## Unlimited allowance to strategies enables draining harvester-held rewards

Acceptable gas savings. Harvester should never hold excess funds.

# Medium Severity

## Rounding threshold DoS in magicPounder.setUserBalance blocks small updates

Removed revert for small updates. Rounding issues should not be any more severe than normal use, and gas costs outweigh any potential benefit to attacking.

## Route test in setRoute pulls tokens from Operator wallet (msg.sender) via _process safeTransferFrom

This is intentional. Operator must provide test amount of tokens to prove route is accurate.