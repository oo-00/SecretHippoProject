Special thanks to Gemach team for valuable insights! 

# High Severity

## Unrestricted harvester route control enables theft/DoS

✔ Fixed

## Stale approvals to previous harvester in setStrategyHarvester allow unauthorized token pulls

✔ Provided additional call argument to remove old approval. Not removed every time because multiple strategies can share a harvester.

## Zero slippage protection on swaps enables MEV/sandwich loss of rewards

✔ Added slippage controls

## notifyReward trusts declared amount; insolvency if fewer tokens actually received (fee-on-transfer/rebasing/misreported)

✔ Fee on transfer and rebasing should not be a concern for current scope of strategies, and is a suitable limitation to not add conflicting strategies. However, a different Harvester could cause misreporting. Moved ERC20 transfer logic to strategy's notifyReward function, so it completes the safeTransferFrom itself and eliminates reporting issue.

## commitVote does not set executed flag, enabling re-cast/tampering after commitment

✔ Fixed

## Validation-casting mismatch: magicVoter validates with one Voter but casts to another via magicStaker

✔ magicStaker now announces update to magicVoter.

## EXECUTE_AFTER vs external votingPeriod mismatch can permanently block casting (DoS)

✔ Changed `EXECUTE_AFTER` constant to `excutionDelay` variable. Operator can update with minimum of 2 days, maximum of Resupply's own `votingPeriod`, minus 12 hours. - Possible Resupply could set votingPeriod to less than 2 days, 12 hours, and still brick voting abilities. Risk is acceptable.

## Zero-address role assignment can permanently brick admin control

✔ Operator role change now utilizes `pendingOperator`, and must be accepted by new operator.

## Arbitrary external executor enables asset drain if operator compromised (centralization risk)

✔ Changed access control to Resupply Core, which is immutable/constant on Resupply side. Enforces Resupply governance controls for execution, including time lock.

## Quorum check uses mutable totalSupply at commit time, enabling outcome manipulation

✘ Unsure of best solution. Local quorum is meant to be a mitigating factor. A user would need ~17% of supply to single-handedly meet quorum with cooldown manipulation.

## Strict zero post-swap tokenIn check enables dust/rebase/evil-DEX DoS

✘ Fee on transfer and rebasing/fee should not be a concern for current scope of strategies, and is a suitable limitation to not add conflicting strategies. evil-DEX should be avoidable with proper Harvester routes.

## No min-shares protection on ERC4626 SreUSD.deposit enables exchange-rate sandwich to under-mint rewards

✘ minshares not an available input on sreusd contract

## External strategy calls in _syncAccount allow a malicious or misconfigured strategy to DoS stake/cooldown/setWeights/syncAccount

✘ `setUserBalance` behavior is validated during `addStrategy`

## Zero-address bricking via magicStaker.setMagicVoter allows permanent governance freeze

✔ Changed from Operator supplied address to Resupply registry enforced.

## Infinite desiredToken allowance to new Strategy in addStrategy enables reward/token drain

✔ Removed. Was part of old logic where Strategy pulls funds from Staker. New logic has strategy pull from Harvester, which should never hold funds.

## Hardcoded epoch base in getEpoch can underflow pre-start and brick time-gated flows

✘ Should never be an issue as timestamp is in the past and corresponds with Resupply staker epochs

## Unbounded strategy iteration in harvest enables gas-based DoS of HarvesterCaller

✘ Splitting harvest introduces strategy weight change exploit, where a user gets paid for multiple strategies. System assumes, and must maintain configuration for low number of strategies.

## Mismatched units in reward split (Strategy.totalSupply vs magicStaker.totalSupply) can over-/under-pull rewards and DoS harvest

✔ Now assigns remaining token balance to last strategy (unless reward is RSUP, where it subtracts existing previous balance). Harvest can still fail if last strategy has 0 weight, but is fixable by any user assigning weight to last strategy.

✘ Rewards can still be under/over pulled by some amount of wei, totalSupply differences should only exist at wei levels, making DoS the real concern.

## setStrategyHarvester allows zero or non-contract address, bricking harvest

✔ Now validates that Harvester has an existing route for reward[0] -> desiredToken


# Medium Severity

## Reward processing stops early if an earlier reward token has zero balance (sentinel break bug)

✔ Changed from break to continue, to ensure all possible rewards are checked. Changed from iterating length of rewardBals (always 10 due to non-dynamically sized arrays in solidity), to rewards.length. This prevents several unneeded continues.

## Fixed-size arrays (length 10) used with unbounded rewards.length cause DoS

✔ rewards.length is now bound as well

## Stale allowance to old magicStaker when rotating in magicPounder.setMagicStaker

✔ Added immutability check so magicStaker can only be set once. Changing magicStaker breaks balances and should never be allowed.

## Rounding guard in magicPounder.underlyingToShares can DoS user syncs and staking flows

✘ Intentional. Even if shares become 100 times more valuable than underlying, it only prevents sub-100 wei changes. This is to prevent claiming/syncing a balance without actually removing shares, if a user makes too small of an adjustment. Maybe I'm thinking about this incorrectly?

## Harvest DoS if any strategy lacks harvester mapping

✘ Acceptable risk. Mitigated partially by expanding access control to RSUP DAO.

## Division-by-zero in harvest when totalSupply is zero causes global reward DoS

✘ Acceptable risk. If totalSupply is zero (everyone has withdrawn 100%), any remaining funds would be small and can be claimed and rescued by DAO, or by anyone depositing.

## External cooldownEpochs trust allows Staker to lock cooldown or cause overflow in modulo check

✘ Resupply Staker has immutable bounded max cooldown already.

## Unchecked resupply voter address allows governance DoS/malicious Voter injection

✔ Now enforces change from Resupply Registry contract

## Zero-address bricking and silent pointer change in magicVoter.setMagicStaker

✔ Now immutable

## Unsafe IERC20.approve usage (no SafeERC20, no zero-first) enables DoS with non-standard tokens

✘ Non-standard tokens should not be added. Using SafeERC20 for IERC20.

## setRoute test sweeps entire tokenOut balance to caller, allowing theft of stray funds

✘ Acceptable. Harvester should never hold funds.

## process sends entire strategyToken balance to strategy, mixing residuals across calls

✘ Acceptable. Harvester should never hold funds.

## notifyReward inflates magicPounder.totalSupply even if magicStake does nothing (misconfigured magicStaker allows phantom supply)

✔ magicStaker now immutable

## Anti-whale voting delay can be bypassed by splitting deposits across transactions/epochs

✔ Now tracks realizedStake in the same manner as native RSUP staking.

## Redundant approve before ScrvUSD.redeem leaves perpetual allowance enabling future share siphoning

✔ Removed

## Caller fee skimming from pre-existing non-RSUP reward balances (e.g., reUSD)

✘ Acceptable. Reward tokens should not sit idle in staker.

## Zero-address share allocation can permanently lock rewards (unclaimable earned[0x0])

✔ Added require statement to both strategies

## Reward token mismatch: desiredToken constant vs rewardToken constructor param can redirect/brick payouts

✔ Now both constant

## Zero-address reward token can be added, bricking harvest and downstream reward processing

✔ Fixed

## OperatorManager constructor allows zero-address operator/manager, risking an irrecoverable bricked admin state at deploy

✔ Mitigated by permanent RSUP DAO full access control

## Zero-address constructor parameters can brick magicSavings and freeze rewards

✔ Fixed

# Low Severity

## Critical role changes lack events, hindering monitoring and incident response

✔ Added role change events

