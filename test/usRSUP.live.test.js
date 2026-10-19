// Smoke test: usRSUP deployed against the LIVE mainnet magic suite (no fresh deployments)

var { ethers } = require("hardhat");
var { expect } = require("chai");
var { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
var { setUpSmartContracts, expectVaultSolvent } = require("./fixtures");
const {
  impersonateAccount,
  setBalance,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const WEEK = 7 * 24 * 60 * 60;
const E18 = 10n ** 18n;

const LIVE_MAGIC_STAKER = "0x64199056cAFF992227ff7c6f544F238b65141990";
const LIVE_MAGIC_POUNDER = "0x29833854b62e21FEF00240F55f399A486970706f";
const RSUP_WHALE = "0x6666666677B06CB55EbF802BB12f8876360f919c";
const REUSD = "0x57aB1E0003F623289CD798B1824Be09a793e4Bec";
const TEAM = "0x000000000000000000000000000000000000a11c"; // stand-in for the team multisig

const CURVE_NG_FACTORY = "0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf";
const curveFactoryAbi = [
    "function deploy_plain_pool(string _name, string _symbol, address[] _coins, uint256 _A, uint256 _fee, uint256 _offpeg_fee_multiplier, uint256 _ma_exp_time, uint256 _implementation_idx, uint8[] _asset_types, bytes4[] _method_ids, address[] _oracles) returns (address)",
    "function get_pool_asset_types(address _pool) view returns (uint8[])",
];
const curvePoolAbi = [
    "function coins(uint256) view returns (address)",
    "function balances(uint256) view returns (uint256)",
    "function stored_rates() view returns (uint256[])",
    "function N_COINS() view returns (uint256)",
    "function A() view returns (uint256)",
    "function fee() view returns (uint256)",
    "function offpeg_fee_multiplier() view returns (uint256)",
    "function ma_exp_time() view returns (uint256)",
    "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
    "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
    "function add_liquidity(uint256[] amounts, uint256 min_mint_amount) returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
];

// withdraw fee for `assets` (in RSUP): withdrawFee bps rounded up, capped at the value of feeCap
async function expectedFee(vault, assets) {
    const pct = (assets * (await vault.withdrawFee()) + 9999n) / 10000n;
    const cap = await vault.convertToAssets(await vault.feeCap());
    return pct < cap ? pct : cap;
}

async function advance(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
}

describe("usRSUP (live magicStaker smoke test)", function () {
    let MagicStaker, RSUP, rsupStaker, vault, vaultAddress, pool, poolAddress;
    let team, keeper;
    let signers = [];
    let firstBatch, secondBatch, cooldownEpochs;
    let harvested = false; // whether live rewards were available for the harvest test
    const users = [
        "0x0000000000000000000000000000000000000021",
        "0x0000000000000000000000000000000000000022",
        "0x0000000000000000000000000000000000000023",
    ];

    async function toCooldownEpoch() {
        while (!(await MagicStaker.isCooldownEpoch())) await advance(WEEK);
    }
    async function toNonCooldownEpoch() {
        if (await MagicStaker.isCooldownEpoch()) await advance(WEEK);
    }
    async function pps() {
        return await vault.convertToAssets(E18);
    }
    const expectSolvent = (accounts) => expectVaultSolvent(vault, MagicStaker, RSUP, accounts);

    before(async function () {
        // Only used to revert to the shared fork-start snapshot, so earlier test files' time travel doesn't leak in.
        await loadFixture(setUpSmartContracts);

        MagicStaker = await ethers.getContractAt("magicStaker", LIVE_MAGIC_STAKER);
        RSUP = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", "0x419905009e4656fdC02418C7Df35B1E61Ed5F726");
        rsupStaker = await ethers.getContractAt(["function cooldownEpochs() view returns (uint256)", "function earned(address,address) view returns (uint256)"], await MagicStaker.staker());
        cooldownEpochs = await rsupStaker.cooldownEpochs();

        await impersonateAccount(RSUP_WHALE);
        await setBalance(RSUP_WHALE, 10n * E18);
        const whale = await ethers.getSigner(RSUP_WHALE);

        await impersonateAccount(TEAM);
        await setBalance(TEAM, 10n * E18);
        team = await ethers.getSigner(TEAM);
        await RSUP.connect(whale).transfer(TEAM, 50000n * E18);

        for (const i in users) {
            await impersonateAccount(users[i]);
            await setBalance(users[i], 10n * E18);
            signers[i] = await ethers.getSigner(users[i]);
            await RSUP.connect(whale).transfer(users[i], 50000n * E18);
        }
        keeper = signers[2];
    });

    describe("Setup and live harvest", () => {
        it("Live magicStaker is the expected deployment", async () => {
            expect(await MagicStaker.strategies(0)).to.equal(LIVE_MAGIC_POUNDER);
            expect(await MagicStaker.paused()).to.equal(false);
        });

        it("Deploys usRSUP against live magicStaker with 100% pounder weight", async () => {
            const factory = await ethers.getContractFactory("usRSUP");
            vault = await factory.connect(team).deploy(LIVE_MAGIC_STAKER);
            vaultAddress = await vault.getAddress();
            const n = await MagicStaker.strategiesLength();
            expect(await MagicStaker.accountStrategyWeight(vaultAddress, 0)).to.equal(10000);
            for (let i = 1n; i < n; i++) {
                expect(await MagicStaker.accountStrategyWeight(vaultAddress, i)).to.equal(0);
            }
        });

        it("Team seeds and users deposit 1:1", async () => {
            await RSUP.connect(team).approve(vaultAddress, ethers.MaxUint256);
            await vault.connect(team).initialize(10n * E18);
            for (const i of [0, 1]) {
                await RSUP.connect(signers[i]).approve(vaultAddress, ethers.MaxUint256);
                await vault.connect(signers[i]).deposit(50000n * E18, users[i]);
                expect(await vault.balanceOf(users[i])).to.equal(50000n * E18);
            }
            expect(await MagicStaker.balanceOf(vaultAddress)).to.equal(100010n * E18);
            expect(await pps()).to.equal(E18);
        });

        it("Live harvest accrues to the vault as locked profit", async function () {
            await advance(WEEK);
            if ((await rsupStaker.earned(LIVE_MAGIC_STAKER, REUSD)) == 0n) {
                console.log("        > no live reUSD rewards accrued at this fork block, skipping");
                this.skip();
            }
            harvested = true;
            const ppsBefore = await pps();
            await MagicStaker.harvest();
            expect(await MagicStaker.unclaimedMagicTokens(vaultAddress)).to.be.gt(0n);
            expect(await pps()).to.equal(ppsBefore);
            await vault.sync();
            expect(await vault.lockedProfit()).to.be.gt(0n);
            expect(await MagicStaker.unclaimedMagicTokens(vaultAddress)).to.equal(0n);
            await advance(WEEK);
            expect(await pps()).to.be.gt(ppsBefore);
        });
    });

    describe("Curve pool", () => {
        it("Deploys a stableswap-ng pool with usRSUP as an ERC4626 asset", async () => {
            const factory = new ethers.Contract(CURVE_NG_FACTORY, curveFactoryAbi, team);
            // coins: RSUP (standard), usRSUP (asset type 3: pool reads convertToAssets as its rate)
            // the settings in usRSUP.md section 2
            const args = ["usRSUP/RSUP", "LPusRSUP", [await RSUP.getAddress(), vaultAddress], 50, 10000000, 20000000000n, 2597, 0, [0, 3], ["0x00000000", "0x00000000"], [ethers.ZeroAddress, ethers.ZeroAddress]];
            poolAddress = await factory.deploy_plain_pool.staticCall(...args);
            await factory.deploy_plain_pool(...args);
            pool = new ethers.Contract(poolAddress, curvePoolAbi, ethers.provider);
            expect(await pool.coins(0)).to.equal(await RSUP.getAddress());
            expect(await pool.coins(1)).to.equal(vaultAddress);
            // the README's post-deploy checks
            expect(await factory.get_pool_asset_types(poolAddress)).to.deep.equal([0n, 3n]);
            expect(await pool.N_COINS()).to.equal(2n);
            expect(await pool.A()).to.equal(50n);
            expect(await pool.fee()).to.equal(10000000n);
            expect(await pool.offpeg_fee_multiplier()).to.equal(20000000000n);
            expect(await pool.ma_exp_time()).to.equal(2597n);
        });
        it("Pool rate oracle tracks the usRSUP share price", async () => {
            const rates = await pool.stored_rates();
            expect(rates[1]).to.equal(await pps());
            // share price is above 1 once the live harvest has run (it skips if no live rewards are available)
            if (harvested) expect(rates[1]).to.be.gt(E18);
        });
        it("Owner sets the pool", async () => {
            await expect(vault.connect(signers[0]).setCurvePool(poolAddress)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await vault.connect(team).setCurvePool(poolAddress);
            expect(await vault.poolRsupIndex()).to.equal(0);
            expect(await vault.poolTokenIndex()).to.equal(1);
        });
        it("Team seeds balanced liquidity", async () => {
            await vault.connect(team).deposit(20000n * E18, TEAM);
            const tokenSide = await vault.balanceOf(TEAM); // ~20k RSUP of value
            await RSUP.connect(team).approve(poolAddress, ethers.MaxUint256);
            await vault.connect(team).approve(poolAddress, ethers.MaxUint256);
            await pool.connect(team).add_liquidity([20000n * E18, tokenSide], 0);
            expect(await pool.balanceOf(TEAM)).to.be.gt(0n);
            expect(await pool.balances(1)).to.equal(tokenSide);
        });
        it("Balanced pool quotes close to the share price", async () => {
            const dx = 100n * E18;
            const out = await pool.get_dy(1, 0, dx);
            const nav = await vault.convertToAssets(dx);
            // within fee (0.10%) plus slippage
            expect(out).to.be.closeTo(nav, nav / 500n);
        });
        it("Instant redemption via withdrawViaCurve", async () => {
            await RSUP.connect(keeper).approve(vaultAddress, ethers.MaxUint256);
            await vault.connect(keeper).deposit(10000n * E18, users[2]);
            const shares = 8000n * E18;
            const quote = await pool.get_dy(1, 0, shares);
            const rsupBefore = await RSUP.balanceOf(users[2]);
            const sharesBefore = await vault.balanceOf(users[2]);
            // the Curve pool itself reverts on its min_dy check, before usRSUP's own Slippage check
            await expect(vault.connect(keeper).withdrawViaCurve(shares, quote + 1n, users[2])).to.be.reverted;
            await vault.connect(keeper).withdrawViaCurve(shares, quote, users[2]);
            expect((await RSUP.balanceOf(users[2])) - rsupBefore).to.equal(quote);
            expect(sharesBefore - (await vault.balanceOf(users[2]))).to.equal(shares);
            expect(await vault.balanceOf(vaultAddress)).to.equal(0n);
        });
        it("Routed deposit buys discounted usRSUP from the pool", async () => {
            // the sale above left the pool heavy in usRSUP -> usRSUP trades below the share price
            const assets = 3000n * E18;
            const fair = await vault.previewDeposit(assets);
            const quote = await pool.get_dy(0, 1, assets);
            expect(quote).to.be.gt(fair);
            const poolTokenBefore = await pool.balances(1);
            const stakeBefore = await MagicStaker.balanceOf(vaultAddress);
            const before = await vault.balanceOf(users[2]);
            await vault.connect(keeper).depositWithRoute(assets, assets, quote, users[2]);
            expect((await vault.balanceOf(users[2])) - before).to.equal(quote);
            expect(await pool.balances(1)).to.be.lt(poolTokenBefore); // pool topped off
            expect(await MagicStaker.balanceOf(vaultAddress)).to.equal(stakeBefore); // nothing minted
        });
        it("Routed deposit splits between swap and mint", async () => {
            const assets = 2000n * E18;
            const swap = 500n * E18;
            const quote = await pool.get_dy(0, 1, swap);
            expect(quote).to.be.gt(await vault.previewDeposit(swap));
            const minted = await vault.previewDeposit(assets - swap);
            const stakeBefore = await MagicStaker.balanceOf(vaultAddress);
            const before = await vault.balanceOf(users[2]);
            await vault.connect(keeper).depositWithRoute(assets, swap, quote + minted, users[2]);
            expect((await vault.balanceOf(users[2])) - before).to.equal(quote + minted);
            expect((await MagicStaker.balanceOf(vaultAddress)) - stakeBefore).to.equal(assets - swap);
        });
        it("Routed deposit reverts if the user expected more", async () => {
            const assets = 1000n * E18;
            const quote = await pool.get_dy(0, 1, assets);
            await expect(vault.connect(keeper).depositWithRoute(assets, assets, quote + 1n, users[2])).to.be.revertedWithCustomError(vault, "Slippage");
        });
        it("Routed deposit mints instead when usRSUP trades at a premium", async () => {
            await RSUP.connect(keeper).approve(poolAddress, ethers.MaxUint256);
            await pool.connect(keeper).exchange(0, 1, 15000n * E18, 0);
            const assets = 1000n * E18;
            const fair = await vault.previewDeposit(assets);
            expect(await pool.get_dy(0, 1, assets)).to.be.lt(fair);
            const poolTokenBefore = await pool.balances(1);
            const before = await vault.balanceOf(users[2]);
            await vault.connect(keeper).depositWithRoute(assets, assets, fair, users[2]);
            expect((await vault.balanceOf(users[2])) - before).to.equal(fair);
            expect(await pool.balances(1)).to.equal(poolTokenBefore); // pool untouched
        });
        it("Pool rate follows the share price as profit unlocks", async () => {
            await vault.sync();
            await advance(2 * 24 * 60 * 60);
            const rates = await pool.stored_rates();
            expect(rates[1]).to.equal(await pps());
        });
    });

    describe("Withdrawal queue and accounting", () => {
        it("harvest() through usRSUP passes the caller fee on and records the yield in one call", async function () {
            await advance(WEEK);
            const reUSD = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", REUSD);
            const earned = await rsupStaker.earned(LIVE_MAGIC_STAKER, REUSD);
            if (earned == 0n) this.skip();
            const expectedFee = ((earned + (await reUSD.balanceOf(LIVE_MAGIC_STAKER))) * (await MagicStaker.CALL_FEE())) / 10000n;
            const ppsBefore = await pps();
            const lockedBefore = await vault.lockedProfit();
            const before = await reUSD.balanceOf(users[2]);
            const tx = await vault.connect(keeper).harvest();
            const fee = (await reUSD.balanceOf(users[2])) - before;
            await expect(tx).to.emit(vault, "HarvestForwarded").withArgs(users[2], REUSD, fee);
            // same fee a direct magicStaker.harvest() would pay (rewards accrue for one more second on-chain)
            expect(fee).to.be.closeTo(expectedFee, expectedFee / 1000n + 1n);
            expect(await reUSD.balanceOf(vaultAddress)).to.equal(0n);
            // yield recorded and realized immediately, share price unchanged in the same block
            expect(await MagicStaker.unclaimedMagicTokens(vaultAddress)).to.equal(0n);
            expect(await vault.lockedProfit()).to.be.gt(lockedBefore);
            expect(await vault.recordedStake()).to.equal(await vault.currentStake());
            expect(await pps()).to.be.gte(ppsBefore);
            // let the harvested profit unlock fully so later tests see a static share price
            await advance(WEEK + 60);
            expect(await vault.lockedProfit()).to.equal(0n);
        });
        it("Queues a withdrawal outside the cooldown epoch", async () => {
            await toNonCooldownEpoch();
            firstBatch = await vault.pendingBatchId();
            const shares = 20000n * E18;
            const assets = await vault.convertToAssets(shares);
            const fee = await expectedFee(vault, assets);
            await vault.connect(signers[0]).requestWithdraw(shares);
            const owed = await vault.requestOf(users[0], firstBatch);
            expect(owed).to.equal(assets - fee);
            await expect(vault.processBacklog()).to.be.revertedWithCustomError(vault, "NotCooldownEpoch");
        });

        it("Keeper processes the backlog in the cooldown epoch", async () => {
            await toCooldownEpoch();
            const fees = await vault.feePot();
            const before = await vault.balanceOf(users[2]);
            await vault.connect(keeper).processBacklog();
            const reward = (await vault.balanceOf(users[2])) - before;
            expect(reward).to.be.gt(0n);
            expect(reward).to.be.lte(await vault.mevCap());
            expect(await vault.convertToAssets(reward)).to.be.lte(fees);
            const b = await vault.batches(firstBatch);
            expect(b.maturityEpoch).to.equal((await MagicStaker.getEpoch()) + cooldownEpochs + 1n);
        });

        it("Vault stays solvent with batches cooling down", async () => {
            await expectSolvent(users);
        });
        it("Cooldown-epoch request is cooled immediately into the same maturity", async () => {
            secondBatch = await vault.nextBatchId(); // immediate cooldowns get their own batch
            await vault.connect(signers[1]).requestWithdraw(10000n * E18);
            const b = await vault.batches(secondBatch);
            expect(b.maturityEpoch).to.equal((await vault.batches(firstBatch)).maturityEpoch);
            expect(await vault.backlogOwed()).to.equal(0n);
            expect(await vault.feePot()).to.equal(0n);
        });

        it("Claims pay exactly what was owed at maturity", async () => {
            await expect(vault.connect(signers[0]).claim([firstBatch], users[0])).to.be.revertedWithCustomError(vault, "NotClaimable");
            await advance(Number(cooldownEpochs + 1n) * WEEK);
            for (const [i, id] of [[0, firstBatch], [1, secondBatch]]) {
                const owed = await vault.requestOf(users[i], id);
                const before = await RSUP.balanceOf(users[i]);
                await vault.connect(signers[i]).claim([id], users[i]);
                expect((await RSUP.balanceOf(users[i])) - before).to.equal(owed);
            }
        });

        it("Accounting matches live magicStaker", async () => {
            await vault.sync();
            expect(await vault.recordedStake()).to.equal(await vault.currentStake());
            expect(await RSUP.balanceOf(vaultAddress)).to.equal(0n);
            expect(await vault.backlogOwed()).to.equal(0n);
            await expectSolvent(users);
        });
    });
});
