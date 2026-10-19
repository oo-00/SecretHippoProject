# usRSUP: Unofficial Staked RSUP

usRSUP is a transferable, auto-compounding vault token over RSUP, built on the deployed `magicStaker`
(`0x64199056cAFF992227ff7c6f544F238b65141990`). The vault is a single magicStaker account weighted 100% to
the magic pounder, so all rewards compound into more staked RSUP.

- **Deposit.** RSUP is staked 1:1. At first, 1 usRSUP = 1 RSUP; the share price rises as yield compounds.
- **Routed deposit.** `depositWithRoute` buys usRSUP from the usRSUP/RSUP Curve pool instead of minting when the
  pool pays more, which also tops the pool back up.
- **Withdraw.**
  - Instantly: sell on Curve (`withdrawViaCurve`, or the pool directly).
  - At the share price: `requestWithdraw`, which queues the RSUP through magicStaker's cooldown (0.1% fee by default, at most `feeCap` = 25 usRSUP worth per request by default; see
    [Withdrawal timing](#withdrawal-timing)). Then `claim` once it matures.
- **No voting power for holders.** The vault's magicStaker weight is only used by the optional quorum boost (and,
  as an escape hatch, by whatever the owner calls through `execute`).

Source: [contracts/usRSUP.sol](contracts/usRSUP.sol) (MIT). Tests: `test/usRSUP*.test.js`, `test/fuzzing/usRSUPEchidna.sol`.

### Withdrawal timing

magicStaker only accepts cooldowns in cooldown weeks (currently every 3rd week, with a 2-week cooldown after that).

| When the request is made | What happens | Claimable after |
|---|---|---|
| During a cooldown week | Cooled immediately | 2–3 weeks (the next cooldown week) |
| In one of the two weeks between | Queued; cooled at the start of the next cooldown week | 3–5 weeks |
| During a cooldown week, but larger than the vault's realized stake left after the queue is cooled (e.g. right after large deposits, or when almost everyone exits at once) | Overflow: cooled at the next cooldown week | up to 6 weeks |
| During a cooldown week while magicStaker temporarily rejects cooldowns | Overflow; still coolable this week once magicStaker recovers if it fits behind the queue | usually 2–3 weeks; `estimatedClaimEpoch` tells |
| During a cooldown week while `canCooldown()` is false (magicStaker's schedule doesn't allow the vault to cool down) | Queued with the between-weeks requests; cooled at the next cooldown week | 5–6 weeks |

- Queued requests are cooled by whoever acts first in the cooldown week: the keeper, anyone calling `processBacklog`,
  or any user's own cooldown-week request. If nobody does, they wait another 3-week cycle.
- `estimatedClaimEpoch(batchId)` gives the expected claim epoch, and the firm one once the batch is cooling down.
- The RSUP owed is fixed when the request is made and is paid in full: a batch is only ever cooled whole. Queued RSUP stays staked until it is cooled, but its yield goes to
  the remaining holders; RSUP cooling down earns nothing, as with magicStaker's own cooldown.
- The cycle follows magicStaker's `cooldownEpochs`; if governance changes it, the timings above change with it.

---

## 1. Deploy

1. **Compile** `contracts/usRSUP.sol` with:
   - Solidity **0.8.30**
   - Optimizer **on, 200 runs**
   - **viaIR off** (usRSUP uses the legacy pipeline; only the magic contracts need via-IR)
   - EVM version **prague**

   Two settings are not optional. With the optimizer **off** usRSUP is about 35 KB, over the
   24,576-byte contract size limit, so the deploy fails. And OpenZeppelin 5.6 needs EVM version **cancun or later**
   (it uses `mcopy`); shanghai or earlier won't compile.

   These are the settings the tests use (the `overrides` entries in `hardhat.config.js`). The magic contracts were
   built differently (via-IR, paris); that doesn't affect usRSUP.
   - Upload `contracts/usRSUP.sol` (it has no local imports).
   - Imports are OpenZeppelin **5.6.1**, the version the tests use. Check the version under `.deps/npm/@openzeppelin/`
     If a newer release is out by then, pin it by changing the imports to `@openzeppelin/contracts@5.6.1/...`
     That edit changes the source, so the verified source won't match this repository's file byte for byte; the
     behaviour is identical. Alternatively, upload the file with its imports unchanged while 5.6.1 is still current.
   - Optimized, the contract is about 22.4 KB, roughly 2.2 KB under the 24,576-byte limit; mind that headroom when
     editing it.
   - OpenZeppelin's "Unreachable code" warnings in `ERC4626.sol` are expected (usRSUP disables sync withdrawals).
2. **Deploy** with one constructor argument: `_magicStaker = 0x64199056cAFF992227ff7c6f544F238b65141990`.
   - The deployer becomes `owner`.
   - The token name and symbol are fixed: "Unofficial Staked RSUP" / "usRSUP".
   - The constructor sets the vault's magicStaker weights to 100% pounder.
3. **Verify** on Etherscan with the Standard-JSON input, licence
   **MIT**, same compiler settings. Don't reuse the magic contracts' Standard-JSON (via-IR, paris) for this.
4. **Seed** the vault, which also enables deposits:
   1. `RSUP.approve(usRSUP, seed)`
   2. `usRSUP.initialize(seed)`, where `seed` is at least 1 RSUP. 10 RSUP is plenty.

   The seed shares are minted to `0x…dEaD` and locked forever, which protects against share-inflation attacks.

   Etherscan takes token amounts in wei (18 decimals): 10 RSUP is `10000000000000000000`.
5. **Create and set the Curve pool** (section 2).
6. **Hand over** to Resupply governance (section 3).

Until step 4 runs, deposits revert (`maxDeposit` returns 0, and `depositWithRoute` reverts with `NotInitialized`).

## 2. Curve pool configuration

Use the Curve **stableswap-ng factory** `0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf` → `deploy_plain_pool`
(Etherscan "Write Contract" works).

| Argument | Value | Why |
|---|---|---|
| `_name` | `usRSUP/RSUP` | at most 32 chars |
| `_symbol` | `LPusRSUP` | at most 10 chars; it only names the LP token |
| `_coins` | `[0x419905009e4656fdC02418C7Df35B1E61Ed5F726, <usRSUP>]` | RSUP first, so `price_oracle(0)` reads as "usRSUP price ÷ share price" |
| `_A` | `50` | see below |
| `_fee` | `10000000` (0.10%) | 1e10 precision; half goes to veCRV |
| `_offpeg_fee_multiplier` | `20000000000` (2×) | mild; the pool is imbalanced by design |
| `_ma_exp_time` | `2597` | raw EMA time; a 30-minute half-life for `price_oracle` (2597 × ln 2 ≈ 1800 s). **In Curve's UI enter `1800`** (see below) |
| `_implementation_idx` | `0` | the only plain-pool implementation on the factory |
| `_asset_types` | `[0, 3]` | RSUP standard; usRSUP is **ERC4626**, so the pool prices it with `convertToAssets` |
| `_method_ids` | `["0x00000000", "0x00000000"]` | unused for types 0 and 3 |
| `_oracles` | `["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000"]` | unused for types 0 and 3 |

**Using Curve's UI instead of Etherscan.** The UI asks for some values in different units:

| UI field | Enter | Becomes |
|---|---|---|
| Token A / Token B | RSUP as **Standard**, usRSUP as **ERC4626** | `_coins`, `_asset_types = [0, 3]` |
| Amplification (A) | `50` | `50` |
| Fee | `0.1` (%) | `10000000` |
| Off-peg fee multiplier | `2` | `20000000000` |
| Moving average time | `1800` (the half-life, in seconds) | `2597` |
| Symbol | `LPusRSUP` | `LPusRSUP` |

Don't type the raw `2597` into the UI's moving-average field: it is accepted and becomes a ~43-minute half-life
(raw 3747). The pool works either way, but the post-deploy check below expects 2597.

**Why these values**
- **Where the price sits.** Exiting at the share price takes weeks (see Withdrawal timing), so usRSUP is expected to
  trade at a small discount to its share price that moves with the 3-week cycle.
- **A = 50.** At a 1–3% discount this keeps the pool about 60–75% usRSUP and leaves the most depth for sellers.
  - Higher A (≥200) sits at 76–86% usRSUP and falls off a cliff under sell pressure.
  - Lower A (≤20) costs more slippage near the share price.
- **Fee 0.10%.** Sits between redeemable vault-token pools (0.005–0.02%) and liquid-locker pools (0.10–0.25%).
  It protects LPs from arbitrageurs who time the queue.
- **30-minute oracle half-life.** Only `price_oracle()` uses it; swaps price off the live balances, so it doesn't slow
  arbitrage. A longer average is harder to manipulate, and its lag hardly matters because the oracle tracks only
  usRSUP's discount to its share price (multiply by `stored_rates()[1]` for a price in RSUP).

**After deployment**
1. **Find the pool address** from your own deployment: the address Curve's UI shows, or on Etherscan the contract
   your deploy transaction created (the emitter of its first log). Not from `PlainPoolDeployed` (that event doesn't
   include the address), and not from `factory.find_pool_for_coins(RSUP, usRSUP, 0)` alone: anyone can create a
   pool for the pair, and that returns the first one. `setCurvePool` only checks the two coins, so the address must
   be right.
2. **Check it before adding liquidity** (all read-only):
   - `factory.get_pool_asset_types(pool) == [0, 3]`. **The critical one.** At launch the share price is exactly 1, so
     a pool that wrongly lists usRSUP as a Standard token looks identical until yield accrues, and would then sell
     usRSUP to arbitrageurs at 1 RSUP while it is worth more.
   - `N_COINS() == 2`, `coins(0) == RSUP`, `coins(1) == usRSUP`
   - `A() == 50`, `fee() == 10000000`, `offpeg_fee_multiplier() == 20000000000`, `ma_exp_time() == 2597`
   - `stored_rates()[1] == usRSUP.pricePerShare()`
   - `totalSupply() == 0` (nobody has added liquidity yet)
3. **Seed balanced liquidity** (by value, at the share price):
   1. `RSUP.approve(usRSUP, x)` (the earlier approval was used up by `initialize`), then `usRSUP.deposit(x, team)`.
   2. Approve the pool for both tokens.
   3. `add_liquidity([rsupAmount, usrsupAmount], minLp)` with `usrsupAmount = rsupAmount * 1e18 / usRSUP.pricePerShare()`.
      Both amounts must be non-zero. Set `minLp` to about 99% of `rsupAmount + usrsupAmount * pricePerShare / 1e18`
      rather than 0.
4. **Point the vault at the pool**: `usRSUP.setCurvePool(pool)`, then check `curvePool() == pool`,
   `poolRsupIndex() == 0` and `poolTokenIndex() == 1`. (Setting the pool before it has liquidity is harmless:
   routed deposits that would swap just revert until it is funded.)
   - The owner can replace the pool later (e.g. with a better-tuned one), or remove it with `address(0)`.
   - The vault never approves the pool (it sends tokens and calls `exchange_received`), so replacing the pool
     leaves nothing behind.

**Changing pool parameters later.** `ramp_A`, `set_new_fee` and `set_ma_exp_time` are restricted to the factory
admin (the Curve DAO). In practice, fixing a badly tuned pool means deploying a new one and having the owner call
`setCurvePool`.

## 3. Handover to Resupply governance

usRSUP has a single owner (OpenZeppelin `Ownable`). Once the pool is set and the vault is running, the owner calls
`transferOwnership(0xc07e000044F95655c11fda4cD37F70A94d7e0a7d)` (`RESUPPLY_CORE`). It takes effect immediately, with
no acceptance step, so governance doesn't need to vote. From then on every owner function below is Resupply
governance's alone.

**Before handing over**, do everything that needs the owner (pool, `setCurvePool`, any parameter changes): afterwards
each change needs a governance vote. Then check the vault:
- `owner()` is your deployer, `asset()` is RSUP, `magicStaker()` is `0x64199056cAFF992227ff7c6f544F238b65141990`
- `magicStaker.accountStrategyWeight(usRSUP, 0) == 10000` (100% pounder)
- `initialized()` is true, `balanceOf(DEAD())` is the seed, and `pricePerShare() == 1e18` (before any yield)
- `withdrawFee() == 10`, `feeCap() == 25e18`, `mevCap() == 100e18`, `paused()` is false
- the pool checks above, and `curvePool()` is the pool

After `transferOwnership`, confirm `owner() == 0xc07e000044F95655c11fda4cD37F70A94d7e0a7d`.

**Double-check the address before sending.** The transfer is irreversible: there is no acceptance step to catch a
typo, and `renounceOwnership` is disabled. It must be exactly `0xc07e000044F95655c11fda4cD37F70A94d7e0a7d`, the same
`RESUPPLY_CORE` the magic contracts use (`contracts/operatorManager.sol`).

Until the transfer, the deployer holds all of these powers, including `execute`. `renounceOwnership` is disabled
(it would freeze every setting forever); hand over with `transferOwnership`.

**Owner functions:**
- `initialize` (once)
- `setCurvePool`
- `setPaused`, which pauses **deposits only**. Withdrawal requests, processing and claims can never be paused.
- the parameters below, and `execute`

## 4. Owner parameters

| Parameter | Default | Bounds | Setter |
|---|---|---|---|
| Withdraw fee rate | 0.1% | at most 1% | `setWithdrawFee(bps)` |
| Max withdraw fee per request, charged as its RSUP value (0 = no withdraw fee) | 25 usRSUP | at most 1000 usRSUP | `setFeeCap(shares)` |
| Max keeper reward per `processBacklog` call (0 = no keeper reward) | 100 usRSUP | at most 1000 usRSUP | `setMevCap(shares)` |
| Quorum boost threshold | 10% of non-vault power | 5%–20% | `setBoostQuorum(bps)` |
| Boost delay after proposal creation | 0 | at most 7 days | `setBoostDelay(seconds)` |
| Quorum boost on/off | on | | `setBoostEnabled(bool)` |
| Curve pool (replace, or `address(0)` to switch routing off) | | must contain RSUP and usRSUP | `setCurvePool(pool)` |

`execute(to, value, data)` is an escape hatch that makes arbitrary calls from the vault. It is owner-only: the
deployer until handover, then Resupply governance. (On the magic contracts, `execute` is hard-wired to
`RESUPPLY_CORE` instead.)

**Fees and the keeper reward.** Each request's fee is `withdrawFee` of its RSUP, capped at what `feeCap` is worth (so
with the defaults, requests of 25,000 usRSUP or more pay the full cap). A keeper is paid the processed batches' fees, up
to `mevCap`; with the defaults that takes at least 100,000 usRSUP of queued requests before the keeper cap binds (more
if any request is above 25,000 usRSUP, since its fee is capped).
Whatever the keeper isn't paid stays in the vault for holders. The two caps are independent: `feeCap = 0` turns off
the fee, `mevCap = 0` turns off the keeper reward.

**Quorum boost.** While `boostEnabled`, once magicStaker's direct voters (excluding the vault) reach `boostQuorumBps`
of the non-vault voting power, and both magicVoter's voting delay and `boostDelay` have passed, anyone can call
`boostQuorum(id)`.
- The vault then votes with the **same yes/no split** as the existing voters (to within 1 bp of rounding), so it never
  changes the split. It can, however, carry the vote over magicStaker's own 20% quorum.
- The vote must commit in the same transaction.
- If usRSUP becomes the dominant magicStaker account, the owner can switch the boost off with
  `setBoostEnabled(false)`.

## 5. Operations

**Keeper: `processBacklog()`**
- Call it at the start of each cooldown week, when `usRSUP.canCooldown()` is true (currently every 3rd epoch). Use
  `canCooldown()` rather than magicStaker's `isCooldownEpoch()`: in a cooldown week where magicStaker's schedule
  doesn't allow the vault to cool down, `processBacklog` reverts with `NotCooldownEpoch`.
- It cools the pending batch, then the overflow batch if it is coolable this week, each only if it fits the realized
  stake left. It pays the caller the usRSUP value of the cooled batches' fees, up to `mevCap` usRSUP; the rest of the
  fees stay in the vault as profit. A batch that doesn't fit, or an overflow batch that has to wait for the next
  cooldown week, stays queued (`estimatedClaimEpoch` shows when it is due).
- Any withdrawal request made while `canCooldown()` is true clears the backlog itself (if magicStaker accepts the
  cooldown), with no reward. So a keeper's call can find nothing to do (`NothingToProcess`).
- `processBacklog` re-throws magicStaker's revert if magicStaker rejects the cooldown. Retry later in the same week.
- Also re-run it whenever `estimatedClaimEpoch` of the pending or overflow batch equals `currentEpoch + period`
  (period = `cooldownEpochs + 1`): that batch is coolable now. This happens, for example, when a rejection earlier in
  the week left an overflow batch that is still coolable that week.
- The reward is not a reliable incentive, so run a backstop keeper. If nobody processes the backlog during a cooldown
  week, it waits another 3 weeks.

**Harvest bot: `usRSUP.harvest()`**
- Calls `magicStaker.harvest()`, passes the harvest caller fee it pays the vault (reUSD, and any other reward
  tokens) on to the caller, then records the vault's new yield. Only what that harvest paid is passed on; reward
  tokens that reached the vault any other way stay put.
- It pays the same fee as calling `magicStaker.harvest()` directly, so an existing "harvest occasionally" bot can
  simply point at usRSUP instead, and the vault never waits for a separate `sync()`.
- It costs about 150k gas more than a direct harvest, because it also records the yield (the vault's first harvest
  costs about 200–270k more, since it writes some storage for the first time). The absolute cost of a harvest depends
  on magicStaker's state and reward tokens; in testing a direct harvest was roughly 1.3–1.7M gas.
- If a reward token's vault balance ever fell during the harvest (e.g. a negatively rebasing token), `harvest()`
  would revert; calling `magicStaker.harvest()` and then `sync()` still works. reUSD can't do this.

**`sync()`**
- It records new pounder yield as locked profit, which unlocks gradually (a 7-day schedule, blended amount-weighted
  with any profit still unlocking), and converts it into
  magicStaker stake.
- These record new yield first: `deposit`, `mint`, `depositWithRoute`, `requestWithdraw`, `processBacklog`, `harvest`.
  It is also converted into magicStaker stake (so it can be cooled down from the next epoch) by `requestWithdraw`,
  `processBacklog`, `harvest` and `sync`, and by any deposit that stakes RSUP, since `magicStaker.stake` does it
  itself. Only a `depositWithRoute` that goes entirely through Curve just records it.
- Yield that hasn't been recorded yet isn't lost. It isn't in `totalAssets` until recorded, and every action that
  mints or burns shares records it first, so nobody can capture it unfairly. The only effect of a late sync is that
  the share price shows the yield later.
- If someone harvests magicStaker directly (not through usRSUP), calling `sync()` afterwards keeps that delay short.
- Transfers deliberately don't sync:
  - Checking for new yield costs about 19.5k gas.
  - Recording it costs about 150–200k gas when there is some, and that would land on random transfers, including
    every Curve swap.

**Worth monitoring**
- `backlogOwed`
- `overflowBatchId` / `overflowEpoch`: a non-zero batch with `overflowEpoch` equal to the current epoch is waiting for
  the next cooldown week. Whether it is coolable now also depends on `canCooldown()` and the stake left after the
  pending batch, so check `estimatedClaimEpoch(overflowBatchId) == currentEpoch + period` instead.
- `lockedProfit()`
- `canCooldown()`: false in a cooldown week means magicStaker's cooldown schedule changed, and requests will queue.
- magicStaker `paused()`: normal deposits revert; routed deposits that go fully through Curve still work.

## 6. Integrator notes

- **The share price is not the exit price.**
  - `convertToAssets` is the share price in RSUP. Exiting at that price takes weeks (see Withdrawal timing).
  - The instant exit price is the Curve price, which is usually somewhat lower.
  - Value usRSUP collateral at the **lower** of the two.
- **Withdrawals are async.**
  - `maxWithdraw`/`maxRedeem` return 0.
  - `withdraw`/`redeem` and `previewWithdraw`/`previewRedeem` revert with `AsyncWithdrawOnly`. This is on purpose,
    so nothing mistakes usRSUP for instantly redeemable.
  - Use `requestWithdraw(shares)` → `claim(batchIds, receiver)`. Requests are recorded to the caller only.
  - `accountActiveBatchIds(account)` lists the batches an account can still claim from. `requestOf(account, id)`,
    `claimable(account, id)`, `batchReleased(id)` and `estimatedClaimEpoch(id)` give the
    queue state.
- **Deposits are standard ERC-4626.** `deposit`/`mint` mint at the share price. Use `depositWithRoute` if you want
  Curve routing.
- **Building a price oracle for usRSUP.** The Curve pool's `price_oracle(0)` for this pool is quoted **relative to the
  share price**. RSUP value per usRSUP = `price_oracle(0) × convertToAssets(1e18) / 1e18`.
  - **What "smooth `convertToAssets` yourself" means.** Don't let your oracle accept an arbitrary jump in the share
    price just because the vault reports it. Either:
    - store the last rate you accepted and cap how fast you let it rise, e.g. `newRate ≤ lastRate × (1 + maxAPR × elapsed / 1 year)`, or
    - use your own time-weighted average of `convertToAssets`.
  - **Why.** The LlamaLend sDOLA exploit (March 2026) combined a slow-moving Curve EMA price with a vault rate read
    at a single instant. An attacker inflated the vault rate within one transaction, the product spiked while the EMA
    couldn't react, and they borrowed against the inflated value.
  - **Why this is defence in depth for usRSUP.** usRSUP's rate can't jump within a block: it uses internal accounting,
    so donations don't count, and new profit unlocks gradually over about 7 days. The cap protects you anyway against a
    future bug or a governance `execute` call.
  - **Never** use `get_p`, `get_dy` or pool balances as an oracle; they can be moved within a single transaction.
- **The share price never decreases in normal operation**, apart from wei-level rounding (magicPounder's share
  rounding can record a loss of a few wei). It could only fall meaningfully if magicStaker itself lost stake, which
  this design doesn't produce.

## 7. Known behaviours

These were reviewed and accepted as part of the design.

- **Cooldown-week exits are first come, first served.** Immediate cooldowns use magicStaker's realized stake, and RSUP
  deposited in the same cooldown week isn't realized yet. So someone who deposits and immediately exits in a cooldown
  week can use up realized stake, pushing later requesters that week into overflow (3 weeks later). Nothing is lost,
  and displacing everyone would take capital close to the vault's whole realized stake.
- **Mass exit in a cooldown week.** Yield synced during a cooldown week partly unlocks that week, but its stake is only
  realized the next week. If nearly everyone exits in that same week, the realized stake can fall short of what is
  queued. Cooling a batch is all-or-nothing, so the batch that doesn't fit (which can be the whole pending batch, not
  just the last requests) waits for the next cycle, while smaller requests that still fit are cooled. Nothing is lost.
- **Overflow triggers.** A cooldown-week request goes to the overflow batch if it is larger than the realized stake
  left after the queue is cooled, or if magicStaker rejects the cooldown. A rejected request keeps the overflow batch
  coolable that same week only if it still fits behind what is cooled before it (the pending batch, then the overflow
  batch's earlier requests). In two cases everyone in the overflow batch waits a cycle: a request that doesn't fit
  behind the queue joins it (in either order relative to a rejection), or the pending batch uses up the stake.
  `estimatedClaimEpoch` always reflects the current outcome. One exception: in the epoch magicStaker migrates to a
  new staker, it rejects every cooldown while still reporting realized stake, so a request then can be shown as
  coolable that week when it actually waits a cycle.
- **Keepers can win back their own fee.** A requester who also calls `processBacklog` receives the keeper reward,
  which can include their own withdraw fee (at most `feeCap` per request; the reward is at most `mevCap` per
  `processBacklog` call, and one cooldown week can pay twice, for the pending batch and later for an overflow batch).
- **Boost threshold scales with the non-vault power.** If usRSUP holds most of magicStaker, a small group of direct
  stakers can reach `boostQuorumBps` and commit magicStaker's whole vote at their split. The owner can raise
  `boostDelay` or switch the boost off with `setBoostEnabled(false)`.

## 8. Testing

```bash
npx hardhat test                              # full suite on a mainnet fork (live magic contracts)
npx hardhat test test/usRSUP.test.js           # usRSUP against the live magicStaker
npx hardhat test test/usRSUP.live.test.js      # smoke test incl. Curve pool
npx hardhat test test/usRSUP.failures.test.js  # magicStaker failure injection (contracts/test/MockMagicStaker.sol)
SOLC_VERSION=0.8.30 echidna test/fuzzing/usRSUPEchidna.sol --contract usRSUPEchidna --config echidna.usRSUP.yaml  # invariant fuzzing
```

The fork starts at the latest mainnet block, and the tests read live values (magicStaker's cooldown cycle, staked
totals, reward availability) rather than assuming them. For a reproducible run, pin a block with an archive RPC:
`MAINNET_RPC_URL=<archive rpc> FORK_BLOCK=<block> npx hardhat test`. The default public RPC only serves recent
state, so it can't be pinned.

Everything in `contracts/test/` (`MockMagicStaker`, `MockMagicVoter`, `MockBadCurvePool`) is for tests only. Never
deploy it.

Node.js 20 or later is recommended for Hardhat; Node 18 works but prints a warning.
