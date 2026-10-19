var { ethers } = require("hardhat");
var { expect } = require("chai");
var { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
var { setUpSmartContracts, expectVaultSolvent } = require("./fixtures");
const {
  impersonateAccount,
  setBalance,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const WEEK = 7 * 24 * 60 * 60;
const E18 = 10n ** 18n;

const curveFactoryAddress = "0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf"; // stableswap-ng factory
const curveFactoryAbi = [
    "function deploy_plain_pool(string _name, string _symbol, address[] _coins, uint256 _A, uint256 _fee, uint256 _offpeg_fee_multiplier, uint256 _ma_exp_time, uint256 _implementation_idx, uint8[] _asset_types, bytes4[] _method_ids, address[] _oracles) returns (address)",
];
const curvePoolAbi = [
    "function coins(uint256) view returns (address)",
    "function balances(uint256) view returns (uint256)",
    "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
    "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)",
    "function add_liquidity(uint256[] amounts, uint256 min_mint_amount) returns (uint256)",
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

describe("usRSUP", function () {
    let MagicStaker, MagicPounder, MagicVoter, MagicHarvester, MagicSavings;
    let MagicStakerAddress, MagicPounderAddress, MagicHarvesterAddress, MagicSavingsAddress;
    let reUSD, RSUP, sreUSD, voter, deployer;
    let RSUPAddress, reUSDAddress, sreUSDAddress;
    let vault, vaultAddress, pool, poolAddress;
    let signers = { users: [] };
    let PERIOD; // magicStaker cooldown cycle in epochs (cooldownEpochs + 1), read live
    let rsupStaker;
    let liveRewards = false; // whether live reUSD rewards were available to harvest
    const REUSD = "0x57aB1E0003F623289CD798B1824Be09a793e4Bec";
    // skips a test when the live Resupply staker has no rewards to harvest at this fork block
    async function requireLiveRewards(ctx) {
        if ((await rsupStaker.earned(MagicStakerAddress, REUSD)) == 0n) {
            console.log("        > no live reUSD rewards accrued at this fork block, skipping");
            ctx.skip();
        }
    }
    const users = [
        "0x0000000000000000000000000000000000000011",
        "0x0000000000000000000000000000000000000012",
        "0x0000000000000000000000000000000000000013",
        "0x0000000000000000000000000000000000000014",
        "0x0000000000000000000000000000000000000015",
        "0x0000000000000000000000000000000000000016",
        "0x0000000000000000000000000000000000000017",
    ];
    const core = "0xc07e000044F95655c11fda4cD37F70A94d7e0a7d";
    const TEAM = "0x000000000000000000000000000000000000a11d"; // deployer: usRSUP owner until handover

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
        ({ MagicPounder, MagicVoter, MagicStaker, MagicHarvester, MagicSavings, reUSD, RSUP, sreUSD, voter } = await loadFixture(setUpSmartContracts));
        MagicStakerAddress = await MagicStaker.getAddress();
        MagicPounderAddress = await MagicPounder.getAddress();
        MagicHarvesterAddress = await MagicHarvester.getAddress();
        MagicSavingsAddress = await MagicSavings.getAddress();
        RSUPAddress = await RSUP.getAddress();
        reUSDAddress = await reUSD.getAddress();
        sreUSDAddress = await sreUSD.getAddress();

        for (const [name, addr] of [["core", core], ["deployer", TEAM]]) {
            await impersonateAccount(addr);
            signers[name] = await ethers.getSigner(addr);
            await setBalance(addr, 10n * E18);
        }
        deployer = TEAM; // the live magic suite is already configured

        const RSUPwhale = "0x6666666677B06CB55EbF802BB12f8876360f919c";
        await impersonateAccount(RSUPwhale);
        await setBalance(RSUPwhale, 10n * E18);
        const whale = await ethers.getSigner(RSUPwhale);
        for (let i in users) {
            await impersonateAccount(users[i]);
            signers.users[i] = await ethers.getSigner(users[i]);
            await setBalance(users[i], 10n * E18);
            await RSUP.connect(whale).transfer(users[i], 200000n * E18);
        }
        // user 5's stake is sized from live state so it is ~10% of non-vault voting power (the boost tests need it
        // between 5% and 20%): s = 10% of (live stake + user 6 + s)  =>  s = (live + user 6) / 9
        const user5Stake = ((await MagicStaker.totalSupply()) + 1500000n * E18) / 9n;
        await RSUP.connect(whale).transfer(users[5], user5Stake + 100000n * E18);
        await RSUP.connect(whale).transfer(users[6], 1500000n * E18);
        await RSUP.connect(whale).transfer(TEAM, 200000n * E18);

        // Direct stakers in the live magicStaker (non-vault voting power): users 5 and 6
        for (const i of [5, 6]) {
            await MagicStaker.connect(signers.users[i]).setWeights([5000, 5000]);
            await RSUP.connect(signers.users[i]).approve(MagicStakerAddress, ethers.MaxUint256);
        }
        await MagicStaker.connect(signers.users[5]).stake(user5Stake);
        rsupStaker = await ethers.getContractAt(["function cooldownEpochs() view returns (uint256)", "function earned(address,address) view returns (uint256)"], await MagicStaker.staker());
        PERIOD = (await rsupStaker.cooldownEpochs()) + 1n;
        await MagicStaker.connect(signers.users[6]).stake(1500000n * E18);
    });

    describe("Deployment", () => {
        it("Deploys usRSUP with 100% pounder weight", async () => {
            const factory = await ethers.getContractFactory("usRSUP");
            vault = await factory.connect(signers.deployer).deploy(MagicStakerAddress);
            vaultAddress = await vault.getAddress();
            expect(await vault.symbol()).to.equal("usRSUP");
            expect(await vault.name()).to.equal("Unofficial Staked RSUP");
            expect(await vault.owner()).to.equal(TEAM);
            expect(await MagicStaker.accountStrategyWeight(vaultAddress, 0)).to.equal(10000);
            expect(await MagicStaker.accountStrategyWeight(vaultAddress, 1)).to.equal(0);
        });
        it("Blocks deposits before initialize", async () => {
            await RSUP.connect(signers.users[0]).approve(vaultAddress, ethers.MaxUint256);
            expect(await vault.maxDeposit(users[0])).to.equal(0);
            expect(await vault.maxMint(users[0])).to.equal(0);
            await expect(vault.connect(signers.users[0]).mint(E18, users[0])).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxMint");
            await expect(vault.connect(signers.users[0]).deposit(E18, users[0])).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
            await expect(vault.connect(signers.users[0]).depositWithRoute(E18, 0, 0, users[0])).to.be.revertedWithCustomError(vault, "NotInitialized");
        });
        it("Only the owner can initialize, with a seed of at least 1 RSUP", async () => {
            await expect(vault.connect(signers.users[0]).initialize(10n * E18)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await expect(vault.connect(signers.deployer).initialize(E18 - 1n)).to.be.revertedWith("!seed");
        });
        it("Owner seeds dead shares", async () => {
            await RSUP.connect(signers.deployer).approve(vaultAddress, ethers.MaxUint256);
            await expect(vault.connect(signers.deployer).initialize(10n * E18)).to.emit(vault, "Initialized").withArgs(10n * E18);
            expect(await vault.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(10n * E18);
            expect(await vault.totalAssets()).to.equal(10n * E18);
            expect(await MagicStaker.balanceOf(vaultAddress)).to.equal(10n * E18);
            await expect(vault.connect(signers.deployer).initialize(10n * E18)).to.be.revertedWith("!initialized");
        });
        it("renounceOwnership is disabled", async () => {
            await expect(vault.connect(signers.deployer).renounceOwnership()).to.be.revertedWithCustomError(vault, "RenounceDisabled");
        });
        it("Owner hands the vault to Resupply governance with transferOwnership", async () => {
            await vault.connect(signers.deployer).transferOwnership(core);
            expect(await vault.owner()).to.equal(core);
            // from here on, admin calls come from RESUPPLY_CORE; the former owner has no powers
            await expect(vault.connect(signers.deployer).setPaused(true)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
        });
    });

    describe("Deposits and ERC4626 surface", () => {
        it("Mints 1:1 at first deposit", async () => {
            for (const i of [0, 1, 2, 3, 4]) {
                await RSUP.connect(signers.users[i]).approve(vaultAddress, ethers.MaxUint256);
                await vault.connect(signers.users[i]).deposit(100000n * E18, users[i]);
                expect(await vault.balanceOf(users[i])).to.equal(100000n * E18);
            }
            expect(await pps()).to.equal(E18);
        });
        it("Leaves no RSUP allowance with magicStaker", async () => {
            expect(await RSUP.allowance(vaultAddress, MagicStakerAddress)).to.equal(0n);
        });
        it("Stakes deposits in magicStaker", async () => {
            expect(await MagicStaker.balanceOf(vaultAddress)).to.equal(500010n * E18);
            expect(await vault.recordedStake()).to.equal(500010n * E18);
        });
        it("Mint takes exactly the previewed assets", async () => {
            const shares = 1000n * E18;
            const assets = await vault.previewMint(shares);
            const before = await RSUP.balanceOf(users[0]);
            await vault.connect(signers.users[0]).mint(shares, users[0]);
            expect(before - (await RSUP.balanceOf(users[0]))).to.equal(assets);
            expect(await vault.balanceOf(users[0])).to.equal(100000n * E18 + shares);
        });
        it("Is transferable", async () => {
            await vault.connect(signers.users[4]).transfer(users[3], 1000n * E18);
            expect(await vault.balanceOf(users[3])).to.equal(101000n * E18);
            await vault.connect(signers.users[3]).transfer(users[4], 1000n * E18);
        });
        it("Sync withdraw/redeem are disabled", async () => {
            expect(await vault.maxWithdraw(users[0])).to.equal(0);
            expect(await vault.maxRedeem(users[0])).to.equal(0);
            await expect(vault.connect(signers.users[0]).withdraw(E18, users[0], users[0])).to.be.revertedWithCustomError(vault, "AsyncWithdrawOnly");
            await expect(vault.connect(signers.users[0]).redeem(E18, users[0], users[0])).to.be.revertedWithCustomError(vault, "AsyncWithdrawOnly");
            await expect(vault.previewRedeem(E18)).to.be.revertedWithCustomError(vault, "AsyncWithdrawOnly");
        });
        it("Pause blocks deposits", async () => {
            await expect(vault.connect(signers.users[0]).setPaused(true)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await expect(vault.connect(signers.core).setPaused(true)).to.emit(vault, "PausedSet").withArgs(true);
            await expect(vault.connect(signers.users[0]).deposit(E18, users[0])).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
            await expect(vault.connect(signers.users[0]).mint(E18, users[0])).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxMint");
            await expect(vault.connect(signers.users[0]).depositWithRoute(E18, 0, 0, users[0])).to.be.revertedWithCustomError(vault, "DepositsPaused");
            await vault.connect(signers.core).setPaused(false);
        });
    });

    describe("Governance parameters", () => {
        it("Only the owner can set parameters", async () => {
            await expect(vault.connect(signers.deployer).setWithdrawFee(20)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await expect(vault.connect(signers.deployer).setMevCap(E18)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await expect(vault.connect(signers.deployer).setFeeCap(E18)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await expect(vault.connect(signers.deployer).setBoostQuorum(1500)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await expect(vault.connect(signers.deployer).setBoostDelay(3600)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await expect(vault.connect(signers.deployer).setBoostEnabled(false)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
        });
        it("Enforces bounds", async () => {
            await expect(vault.connect(signers.core).setWithdrawFee(101)).to.be.revertedWithCustomError(vault, "InvalidParam");
            await expect(vault.connect(signers.core).setMevCap(1001n * E18)).to.be.revertedWithCustomError(vault, "InvalidParam");
            await expect(vault.connect(signers.core).setFeeCap(1001n * E18)).to.be.revertedWithCustomError(vault, "InvalidParam");
            await expect(vault.connect(signers.core).setBoostQuorum(499)).to.be.revertedWithCustomError(vault, "InvalidParam");
            await expect(vault.connect(signers.core).setBoostQuorum(2001)).to.be.revertedWithCustomError(vault, "InvalidParam");
            await expect(vault.connect(signers.core).setBoostDelay(WEEK + 1)).to.be.revertedWithCustomError(vault, "InvalidParam");
        });
        it("Owner can update within bounds", async () => {
            await expect(vault.connect(signers.core).setWithdrawFee(7)).to.emit(vault, "WithdrawFeeSet").withArgs(7);
            // the maximums themselves are accepted
            await expect(vault.connect(signers.core).setFeeCap(1000n * E18)).to.emit(vault, "FeeCapSet").withArgs(1000n * E18);
            await expect(vault.connect(signers.core).setMevCap(1000n * E18)).to.emit(vault, "MevCapSet").withArgs(1000n * E18);
            await expect(vault.connect(signers.core).setMevCap(5n * E18)).to.emit(vault, "MevCapSet").withArgs(5n * E18);
            await expect(vault.connect(signers.core).setFeeCap(3n * E18)).to.emit(vault, "FeeCapSet").withArgs(3n * E18);
            await expect(vault.connect(signers.core).setBoostQuorum(1500)).to.emit(vault, "BoostQuorumSet").withArgs(1500);
            await expect(vault.connect(signers.core).setBoostDelay(3600)).to.emit(vault, "BoostDelaySet").withArgs(3600);
            expect(await vault.withdrawFee()).to.equal(7);
            expect(await vault.mevCap()).to.equal(5n * E18);
            expect(await vault.feeCap()).to.equal(3n * E18);
            expect(await vault.boostQuorumBps()).to.equal(1500);
            expect(await vault.boostDelay()).to.equal(3600);
            // restore defaults
            await vault.connect(signers.core).setWithdrawFee(10);
            await vault.connect(signers.core).setMevCap(100n * E18);
            await vault.connect(signers.core).setFeeCap(25n * E18);
            await vault.connect(signers.core).setBoostQuorum(1000);
            await vault.connect(signers.core).setBoostDelay(0);
        });
    });

    describe("Quorum boost", () => {
        let proposalId;
        it("Creates a proposal once stake is realized", async () => {
            await advance(2 * WEEK);
            proposalId = await voter.getProposalCount();
            await MagicStaker.connect(signers.users[6]).createProposal([{ target: MagicStakerAddress, data: "0x43676852" }], "usRSUP boost test");
            expect(await voter.getProposalCount()).to.equal(proposalId + 1n);
        });
        it("Reverts before magicVoter delay", async () => {
            await MagicVoter.connect(signers.users[5]).vote(proposalId, 10000n, 0n);
            await expect(vault.boostQuorum(proposalId)).to.be.revertedWithCustomError(vault, "BoostTooEarly");
        });
        it("Reverts if staker quorum (excluding vault) not met", async () => {
            const period = await voter.votingPeriod();
            await advance(Number(period / 2n) + 60);
            // user 5's share of non-vault voting power at the proposal epoch
            const createdEpoch = await MagicVoter.timeToEpoch((await voter.getProposalData(proposalId)).createdAt);
            await MagicStaker.checkpointTotal();
            const total = await MagicStaker.totalPowerAt(createdEpoch);
            const vaultPower = await MagicStaker.getVotingPowerAt(vaultAddress, createdEpoch);
            const [yes] = await MagicVoter.voteTotals(await MagicVoter.voter(), proposalId);
            const pct = (yes * 10000n) / (total - vaultPower);
            expect(pct).to.be.gte(500n).and.lt(2000n); // precondition on live state
            await vault.connect(signers.core).setBoostQuorum(2000);
            await expect(vault.boostQuorum(proposalId)).to.be.revertedWithCustomError(vault, "QuorumNotMet");
        });
        it("Respects boostDelay", async () => {
            await vault.connect(signers.core).setBoostQuorum(500);
            await vault.connect(signers.core).setBoostDelay(WEEK);
            await expect(vault.boostQuorum(proposalId)).to.be.revertedWithCustomError(vault, "BoostTooEarly");
            await vault.connect(signers.core).setBoostDelay(0);
        });
        it("Can be disabled by the owner", async () => {
            await expect(vault.connect(signers.core).setBoostEnabled(false)).to.emit(vault, "BoostEnabledSet").withArgs(false);
            await expect(vault.boostQuorum(proposalId)).to.be.revertedWithCustomError(vault, "BoostDisabled");
            await vault.connect(signers.core).setBoostEnabled(true);
        });
        it("Mirrors existing split and commits once staker quorum is met", async () => {
            await vault.boostQuorum(proposalId);
            const rsupVoterAddress = await MagicVoter.voter();
            expect(await MagicVoter.executed(rsupVoterAddress, proposalId)).to.equal(true);
            const w = await voter.accountVoteWeights(MagicStakerAddress, proposalId);
            expect(w.weightNo).to.equal(0n);
            expect(w.weightYes).to.be.gt(0n);
            await vault.connect(signers.core).setBoostQuorum(1000);
        });
        it("Cannot boost twice", async () => {
            await expect(vault.boostQuorum(proposalId)).to.be.revertedWith("Executed");
        });
    });

    describe("Curve pool", () => {
        it("Deploys stableswap-ng pool with usRSUP as ERC4626 asset", async () => {
            const factory = new ethers.Contract(curveFactoryAddress, curveFactoryAbi, signers.deployer);
            // recommended settings: A 50, fee 0.10%, offpeg 2x, ma_exp_time 866 (see usRSUP.md)
            const args = ["usRSUP/RSUP", "usRSUPRSUP", [RSUPAddress, vaultAddress], 50, 10000000, 20000000000n, 866, 0, [0, 3], ["0x00000000", "0x00000000"], [ethers.ZeroAddress, ethers.ZeroAddress]];
            poolAddress = await factory.deploy_plain_pool.staticCall(...args);
            await factory.deploy_plain_pool(...args);
            pool = new ethers.Contract(poolAddress, curvePoolAbi, ethers.provider);
            expect(await pool.coins(1)).to.equal(vaultAddress);
        });
        it("Owner sets the pool", async () => {
            await expect(vault.connect(signers.users[0]).setCurvePool(poolAddress)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await vault.connect(signers.core).setCurvePool(poolAddress);
            expect(await vault.poolRsupIndex()).to.equal(0);
            expect(await vault.poolTokenIndex()).to.equal(1);
            await expect(vault.connect(signers.deployer).setCurvePool(poolAddress)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
        });
        it("The owner can replace the pool", async () => {
            const factory = new ethers.Contract(curveFactoryAddress, curveFactoryAbi, signers.deployer);
            // reversed coin order, to check index handling
            const args = ["usRSUP/RSUP v2", "usRSUPRS2", [vaultAddress, RSUPAddress], 50, 10000000, 20000000000n, 866, 0, [3, 0], ["0x00000000", "0x00000000"], [ethers.ZeroAddress, ethers.ZeroAddress]];
            const pool2 = await factory.deploy_plain_pool.staticCall(...args);
            await factory.deploy_plain_pool(...args);
            await expect(vault.connect(signers.core).setCurvePool(pool2)).to.emit(vault, "CurvePoolSet").withArgs(pool2);
            expect(await vault.poolRsupIndex()).to.equal(1);
            expect(await vault.poolTokenIndex()).to.equal(0);
            // a contract without RSUP/usRSUP as its coins is rejected
            const wrongCoins = await (await ethers.getContractFactory("MockBadCurvePool")).deploy(RSUPAddress, users[0]);
            await expect(vault.connect(signers.core).setCurvePool(await wrongCoins.getAddress())).to.be.revertedWithCustomError(vault, "InvalidParam");
            await vault.connect(signers.core).setCurvePool(poolAddress);
            expect(await vault.curvePool()).to.equal(poolAddress);
            expect(await vault.poolRsupIndex()).to.equal(0);
        });
        it("The owner can switch routing off with address(0) and back", async () => {
            await expect(vault.connect(signers.deployer).setCurvePool(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await vault.connect(signers.core).setCurvePool(ethers.ZeroAddress);
            expect(await vault.curvePool()).to.equal(ethers.ZeroAddress);
            await expect(vault.connect(signers.users[0]).withdrawViaCurve(E18, 0, users[0])).to.be.revertedWithCustomError(vault, "NoPool");
            // with no pool, a routed deposit mints everything
            const fair = await vault.previewDeposit(E18);
            const before = await vault.balanceOf(users[0]);
            await expect(vault.connect(signers.users[0]).depositWithRoute(E18, E18, 0, users[0]))
                .to.emit(vault, "RoutedDeposit").withArgs(users[0], users[0], E18, 0, 0, fair);
            expect((await vault.balanceOf(users[0])) - before).to.equal(fair);
            await expect(vault.connect(signers.deployer).setCurvePool(poolAddress)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await vault.connect(signers.core).setCurvePool(poolAddress);
            expect(await vault.curvePool()).to.equal(poolAddress);
        });
        it("Pool gets no standing RSUP allowance from the vault", async () => {
            expect(await RSUP.allowance(vaultAddress, poolAddress)).to.equal(0n);
        });
        it("Team seeds liquidity", async () => {
            await vault.connect(signers.deployer).deposit(50000n * E18, deployer);
            await RSUP.connect(signers.deployer).approve(poolAddress, ethers.MaxUint256);
            await vault.connect(signers.deployer).approve(poolAddress, ethers.MaxUint256);
            await pool.connect(signers.deployer).add_liquidity([50000n * E18, 50000n * E18], 0);
            expect(await pool.balances(1)).to.equal(50000n * E18);
        });
    });

    describe("Profit smoothing", () => {
        let ppsBefore;
        it("Harvest does not move share price instantly", async function () {
            await advance(WEEK);
            await requireLiveRewards(this);
            liveRewards = true;
            ppsBefore = await pps();
            await MagicStaker.harvest();
            const unclaimed = await MagicStaker.unclaimedMagicTokens(vaultAddress);
            expect(unclaimed).to.be.gt(0n);
            expect(await pps()).to.equal(ppsBefore);
            await expect(vault.sync()).to.emit(vault, "ProfitRecorded").withArgs(unclaimed, anyValue);
            expect(await vault.lockedProfit()).to.be.gt(0n);
            expect(await pps()).to.equal(ppsBefore);
            // yield was realized into magicStaker stake
            expect(await MagicStaker.unclaimedMagicTokens(vaultAddress)).to.equal(0n);
        });
        it("Unlocks linearly over 7 days", async function () {
            if (!liveRewards) this.skip();
            const locked = await vault.lockedProfitStored();
            const supply = await vault.totalSupply();
            await advance(WEEK / 2);
            const mid = await pps();
            expect(mid).to.be.gt(ppsBefore);
            await advance(WEEK / 2);
            expect(await vault.lockedProfit()).to.equal(0n);
            const end = await pps();
            // ~half unlocked at midpoint
            const expectedMid = ppsBefore + (locked * E18) / supply / 2n;
            expect(mid).to.be.closeTo(expectedMid, E18 / 10000n);
            expect(end).to.be.closeTo(ppsBefore + (locked * E18) / supply, E18 / 10000n);
        });
    });

    describe("Harvest through usRSUP", () => {
        it("Anyone can harvest via the vault and receives magicStaker's caller fee", async function () {
            await advance(WEEK);
            await requireLiveRewards(this);
            const reUSD = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", "0x57aB1E0003F623289CD798B1824Be09a793e4Bec");
            // reUSD that reaches the vault some other way is not passed on
            const reUSDHolder = "0xc522A6606BBA746d7960404F22a3DB936B6F4F50";
            await impersonateAccount(reUSDHolder);
            await setBalance(reUSDHolder, 10n * E18);
            await reUSD.connect(await ethers.getSigner(reUSDHolder)).transfer(vaultAddress, 100n * E18);
            const before = await reUSD.balanceOf(users[5]);
            const lockedBefore = await vault.lockedProfit();
            await vault.connect(signers.users[5]).harvest();
            expect(await reUSD.balanceOf(users[5])).to.be.gt(before);
            expect(await reUSD.balanceOf(vaultAddress)).to.equal(100n * E18);
            expect(await RSUP.balanceOf(vaultAddress)).to.equal(0n);
            expect(await vault.lockedProfit()).to.be.gt(lockedBefore);
            expect(await MagicStaker.unclaimedMagicTokens(vaultAddress)).to.equal(0n);
        });
        it("An immediate second harvest has little to pass on and does not revert", async () => {
            await vault.connect(signers.users[5]).harvest();
            // let the harvested profit unlock fully so later tests see a static share price
            await advance(WEEK + 60);
            expect(await vault.lockedProfit()).to.equal(0n);
        });
    });

    describe("Routed deposits", () => {
        it("Never receives less than minting", async () => {
            const assets = 1000n * E18;
            const fair = await vault.previewDeposit(assets);
            const before = await vault.balanceOf(users[1]);
            await vault.connect(signers.users[1]).depositWithRoute(assets, assets, fair, users[1]);
            expect((await vault.balanceOf(users[1])) - before).to.be.gte(fair);
        });
        it("Sells usRSUP via Curve", async () => {
            const shares = 30000n * E18;
            const quote = await pool.get_dy(1, 0, shares);
            const before = await RSUP.balanceOf(users[2]);
            await expect(vault.connect(signers.users[2]).withdrawViaCurve(shares, quote, users[2]))
                .to.emit(vault, "CurveWithdraw").withArgs(users[2], users[2], shares, quote);
            await expect(vault.connect(signers.users[2]).withdrawViaCurve(0, 0, users[2])).to.be.revertedWithCustomError(vault, "ZeroAmount");
            expect((await RSUP.balanceOf(users[2])) - before).to.equal(quote);
        });
        it("Routes through Curve when usRSUP trades at a discount", async () => {
            const assets = 5000n * E18;
            const fair = await vault.previewDeposit(assets);
            const quote = await pool.get_dy(0, 1, assets);
            expect(quote).to.be.gt(fair);
            const poolTokBefore = await pool.balances(1);
            const before = await vault.balanceOf(users[1]);
            await vault.connect(signers.users[1]).depositWithRoute(assets, assets, quote, users[1]);
            const received = (await vault.balanceOf(users[1])) - before;
            expect(received).to.equal(quote);
            expect(received).to.be.gt(fair);
            expect(await pool.balances(1)).to.be.lt(poolTokBefore); // pool topped off
        });
        it("Splits between swap and mint", async () => {
            const assets = 2000n * E18;
            const swap = 500n * E18;
            const fairSwap = await vault.previewDeposit(swap);
            const quote = await pool.get_dy(0, 1, swap);
            expect(quote).to.be.gt(fairSwap);
            const fairMint = await vault.previewDeposit(assets - swap);
            const before = await vault.balanceOf(users[1]);
            await vault.connect(signers.users[1]).depositWithRoute(assets, swap, 0, users[1]);
            expect((await vault.balanceOf(users[1])) - before).to.equal(quote + fairMint);
        });
        it("Routed swaps leave no RSUP allowance or usRSUP in the vault", async () => {
            expect(await RSUP.allowance(vaultAddress, poolAddress)).to.equal(0n);
            expect(await vault.balanceOf(vaultAddress)).to.equal(0n);
        });
        it("Rejects the zero address as receiver", async () => {
            await expect(vault.connect(signers.users[1]).depositWithRoute(E18, 0, 0, ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
            await expect(vault.connect(signers.users[1]).withdrawViaCurve(E18, 0, ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
            await expect(vault.connect(signers.users[1]).claim([], ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");
        });
        it("Folds a remainder worth less than one share into the swap instead of reverting", async function () {
            if (!liveRewards) this.skip(); // needs a share price above 1, from the live harvest
            const assets = 1000n * E18;
            expect(await vault.previewDeposit(1n)).to.equal(0n); // share price above 1
            const quote = await pool.get_dy(0, 1, assets);
            expect(quote).to.be.gt(await vault.previewDeposit(assets));
            const stakeBefore = await MagicStaker.balanceOf(vaultAddress);
            const before = await vault.balanceOf(users[1]);
            await expect(vault.connect(signers.users[1]).depositWithRoute(assets, assets - 1n, 0, users[1]))
                .to.emit(vault, "RoutedDeposit").withArgs(users[1], users[1], assets, assets, quote, 0);
            expect((await vault.balanceOf(users[1])) - before).to.equal(quote);
            expect(await MagicStaker.balanceOf(vaultAddress)).to.equal(stakeBefore); // nothing minted
        });
        it("A pool that misreports swaps can't take routed deposits or exits", async () => {
            const bad = await (await ethers.getContractFactory("MockBadCurvePool")).deploy(RSUPAddress, vaultAddress);
            await vault.connect(signers.core).setCurvePool(await bad.getAddress());
            const assets = 1000n * E18;
            // the pool claims 2x, keeps the RSUP and sends nothing: the receiver's balance change is what counts
            await expect(vault.connect(signers.users[1]).depositWithRoute(assets, assets, 0, users[1])).to.be.revertedWithCustomError(vault, "Slippage");
            await expect(vault.connect(signers.users[1]).withdrawViaCurve(assets, 1n, users[1])).to.be.revertedWithCustomError(vault, "Slippage");
            await vault.connect(signers.core).setCurvePool(poolAddress);
        });
        it("While magicStaker is paused, only fully swapped routed deposits work", async () => {
            await MagicStaker.connect(signers.core).setPaused(true);
            expect(await vault.maxDeposit(users[1])).to.equal(0n);
            await expect(vault.connect(signers.users[1]).deposit(E18, users[1])).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
            const assets = 500n * E18;
            expect(await pool.get_dy(0, 1, assets)).to.be.gt(await vault.previewDeposit(assets));
            await vault.connect(signers.users[1]).depositWithRoute(assets, assets, 0, users[1]); // all via Curve
            await expect(vault.connect(signers.users[1]).depositWithRoute(assets, assets / 2n, 0, users[1])).to.be.revertedWith("paused");
            await MagicStaker.connect(signers.core).setPaused(false);
        });
        it("Rejects an empty deposit and a swap amount above the deposit", async () => {
            await expect(vault.connect(signers.users[1]).depositWithRoute(0, 0, 0, users[1])).to.be.revertedWithCustomError(vault, "ZeroAmount");
            await expect(vault.connect(signers.users[1]).depositWithRoute(E18, E18 + 1n, 0, users[1])).to.be.revertedWithCustomError(vault, "InvalidParam");
        });
        it("Reverts when user expected more than received", async () => {
            const assets = 1000n * E18;
            const quote = await pool.get_dy(0, 1, assets);
            await expect(vault.connect(signers.users[1]).depositWithRoute(assets, assets, quote + 1n, users[1])).to.be.revertedWithCustomError(vault, "Slippage");
        });
        it("Never fails with minSharesOut at the fair amount, even when pool is at a premium", async () => {
            // push usRSUP to a premium
            await RSUP.connect(signers.users[0]).approve(poolAddress, ethers.MaxUint256);
            await pool.connect(signers.users[0]).exchange(0, 1, 40000n * E18, 0);
            const assets = 1000n * E18;
            const fair = await vault.previewDeposit(assets);
            expect(await pool.get_dy(0, 1, assets)).to.be.lt(fair);
            const before = await vault.balanceOf(users[1]);
            await vault.connect(signers.users[1]).depositWithRoute(assets, assets, fair, users[1]);
            expect((await vault.balanceOf(users[1])) - before).to.equal(fair);
        });
    });

    describe("Withdrawal queue", () => {
        let firstBatch, keeper;
        it("Queues a request outside the cooldown epoch", async () => {
            await toNonCooldownEpoch();
            const ppsBefore = await pps();
            const shares = 10000n * E18;
            const assets = await vault.convertToAssets(shares);
            const fee = await expectedFee(vault, assets);
            firstBatch = await vault.pendingBatchId();
            await expect(vault.connect(signers.users[3]).requestWithdraw(shares))
                .to.emit(vault, "WithdrawRequested").withArgs(users[3], firstBatch, shares, assets - fee, fee);
            expect(await vault.requestOf(users[3], firstBatch)).to.equal(assets - fee);
            expect(await vault.feePot()).to.be.gt(0n);
            expect(await pps()).to.be.gte(ppsBefore);
            expect(await vault.claimable(users[3], firstBatch)).to.equal(0n);
        });
        it("Rejects empty requests and dust that would owe nothing after the fee", async () => {
            await expect(vault.connect(signers.users[3]).requestWithdraw(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
            await expect(vault.connect(signers.users[3]).requestWithdraw(1n)).to.be.revertedWithCustomError(vault, "ZeroAmount");
        });
        it("Requests are recorded to the caller only", async () => {
            expect(vault.interface.getFunction("requestWithdraw").inputs.length).to.equal(1);
            expect(await vault.accountActiveBatchIds(users[3])).to.deep.equal([firstBatch]);
        });
        it("Estimates the claim epoch of a queued batch", async () => {
            const epoch = await MagicStaker.getEpoch();
            const nextCooldown = ((epoch + PERIOD - 1n) / PERIOD) * PERIOD; // not a cooldown epoch now
            expect(await vault.estimatedClaimEpoch(firstBatch)).to.equal(nextCooldown + PERIOD);
            expect(await vault.estimatedClaimEpoch(9999n)).to.equal(0n); // unknown batch
        });
        it("Cannot process backlog outside cooldown epoch", async () => {
            await expect(vault.processBacklog()).to.be.revertedWithCustomError(vault, "NotCooldownEpoch");
        });
        it("A large request's fee is capped at the value of feeCap", async () => {
            const shares = 90000n * E18;
            const assets = await vault.convertToAssets(shares);
            const cap = await vault.convertToAssets(await vault.feeCap());
            expect((assets * (await vault.withdrawFee())) / 10000n).to.be.gt(cap); // 0.1% would be ~90 RSUP
            // (the mock suite covers a capped fee at a share price above 1; on the fork the price depends on live rewards)
            const potBefore = await vault.feePot();
            const id = await vault.pendingBatchId();
            await vault.connect(signers.users[4]).requestWithdraw(shares);
            expect((await vault.feePot()) - potBefore).to.equal(cap);
            expect(await vault.requestOf(users[4], id)).to.equal(assets - cap);
        });
        it("Keeper processes backlog in cooldown epoch and earns the fees' value, up to mevCap", async () => {
            await toCooldownEpoch();
            keeper = signers.users[2];
            const ppsBefore = await pps();
            const kBefore = await vault.balanceOf(users[2]);
            const fees = await vault.feePot();
            const owedBefore = (await vault.batches(firstBatch)).owed;
            const cap = await vault.mevCap();
            const feeShares = await vault.convertToShares(fees);
            const reward = feeShares < cap ? feeShares : cap;
            await expect(vault.connect(keeper).processBacklog())
                .to.emit(vault, "BacklogProcessed").withArgs(users[2], owedBefore, fees, reward)
                .and.to.emit(vault, "BatchCooled").withArgs(firstBatch, owedBefore, anyValue);
            expect((await vault.balanceOf(users[2])) - kBefore).to.equal(reward);
            expect(await pps()).to.be.gte(ppsBefore);
            expect(await vault.feePot()).to.equal(0n);
            expect(await vault.backlogOwed()).to.equal(0n);
            // unpaid fees remain in the vault as locked profit
            expect(await vault.lockedProfit()).to.be.gte(fees - (await vault.convertToAssets(reward)) - 1n);
            const b = await vault.batches(firstBatch);
            expect(b.maturityEpoch).to.equal((await MagicStaker.getEpoch()) + PERIOD);
            // the estimate was right, and is now the firm maturity
            expect(await vault.estimatedClaimEpoch(firstBatch)).to.equal(b.maturityEpoch);
        });
        it("Cooldown-epoch requests are cooled immediately without keeper reward", async () => {
            const ppsBefore = await pps();
            const id = await vault.nextBatchId(); // immediate cooldowns get their own batch
            const cdBefore = (await MagicStaker.accountCooldownData(vaultAddress)).amount;
            await vault.connect(signers.users[0]).requestWithdraw(5000n * E18);
            const b = await vault.batches(id);
            expect(b.maturityEpoch).to.equal((await vault.batches(firstBatch)).maturityEpoch);
            expect((await MagicStaker.accountCooldownData(vaultAddress)).amount - cdBefore).to.equal(b.owed);
            expect(await vault.feePot()).to.equal(0n);
            expect(await pps()).to.be.gte(ppsBefore);
            await expect(vault.processBacklog()).to.be.revertedWithCustomError(vault, "NothingToProcess");
            // user 3 now has a second batch with the same maturity
            await vault.connect(signers.users[3]).requestWithdraw(1000n * E18);
            expect((await vault.accountActiveBatchIds(users[3])).length).to.equal(2);
        });
        it("Cooldown-epoch request exceeding realized stake goes to overflow", async () => {
            // user 6 deposits a large amount this epoch -> not yet realized, then exits
            const big = 800000n * E18;
            await RSUP.connect(signers.users[5]).approve(vaultAddress, ethers.MaxUint256);
            await RSUP.connect(signers.users[6]).approve(vaultAddress, ethers.MaxUint256);
            await vault.connect(signers.users[5]).deposit(100000n * E18, users[5]);
            const whale = "0x6666666677B06CB55EbF802BB12f8876360f919c";
            await RSUP.connect(await ethers.getSigner(whale)).transfer(users[6], big);
            await vault.connect(signers.users[6]).deposit(big, users[6]);
            const shares = await vault.balanceOf(users[6]);
            expect(await vault.convertToAssets(shares)).to.be.gt(await vault.availableToCooldown());
            await vault.connect(signers.users[6]).requestWithdraw(shares);
            const oid = await vault.overflowBatchId();
            expect(oid).to.not.equal(0n);
            expect(await vault.requestOf(users[6], oid)).to.be.gt(0n);
            // overflow is only eligible from the next cooldown epoch
            expect(await vault.estimatedClaimEpoch(oid)).to.equal((await MagicStaker.getEpoch()) + 2n * PERIOD);
            expect((await vault.batches(oid)).maturityEpoch).to.equal(0n);
        });
        it("Claims revert before maturity", async () => {
            await expect(vault.connect(signers.users[3]).claim([firstBatch], users[3])).to.be.revertedWithCustomError(vault, "NotClaimable");
        });
        it("Overflow is not processed until the next cooldown epoch", async () => {
            // same cooldown week: the too-large overflow batch is left alone
            const oid = await vault.overflowBatchId();
            await expect(vault.processBacklog()).to.be.revertedWithCustomError(vault, "NothingToProcess");
            expect((await vault.batches(oid)).maturityEpoch).to.equal(0n);
            await expectSolvent(users);
            await advance(WEEK);
            await expect(vault.processBacklog()).to.be.revertedWithCustomError(vault, "NotCooldownEpoch");
            await toCooldownEpoch();
        });
        it("Matured batches pay exactly owed and leave the active set", async () => {
            const ids = await vault.accountActiveBatchIds(users[3]);
            let owed = 0n;
            for (const id of ids) {
                const o = await vault.requestOf(users[3], id);
                expect(await vault.claimable(users[3], id)).to.equal(o);
                owed += o;
            }
            const before = await RSUP.balanceOf(users[3]);
            // claim the first entry alone: swap-and-pop moves the last entry into its place
            expect(ids.length).to.equal(2);
            await vault.connect(signers.users[3]).claim([ids[0]], users[3]);
            expect(await vault.accountActiveBatchIds(users[3])).to.deep.equal([ids[1]]);
            await vault.connect(signers.users[3]).claim([ids[1]], users[3]);
            expect((await RSUP.balanceOf(users[3])) - before).to.equal(owed);
            expect(await vault.requestOf(users[3], firstBatch)).to.equal(0n);
            // claimed batches leave the active set
            expect(await vault.accountActiveBatchIds(users[3])).to.deep.equal([]);
            await expect(vault.connect(signers.users[3]).claim([firstBatch], users[3])).to.be.revertedWithCustomError(vault, "NotClaimable");
            await expect(vault.connect(signers.users[3]).claim([ids[1], ids[1]], users[3])).to.be.revertedWithCustomError(vault, "NotClaimable");
        });
        it("Overflow is processed in the next cooldown epoch", async () => {
            const oid = await vault.overflowBatchId();
            await vault.connect(keeper).processBacklog();
            expect(await vault.overflowBatchId()).to.equal(0n);
            const b = await vault.batches(oid);
            expect(b.maturityEpoch).to.equal((await MagicStaker.getEpoch()) + PERIOD);
            await expectSolvent(users);
        });
        it("Other matured claims pay out", async () => {
            for (const i of [0, 4]) {
                const ids = await vault.accountActiveBatchIds(users[i]);
                expect(ids.length).to.equal(1);
                const owed = await vault.requestOf(users[i], ids[0]);
                const before = await RSUP.balanceOf(users[i]);
                await vault.connect(signers.users[i]).claim([ids[0]], users[i]);
                expect((await RSUP.balanceOf(users[i])) - before).to.equal(owed);
            }
        });
        it("Overflow claim pays out after its maturity", async () => {
            await advance(Number(PERIOD) * WEEK);
            const ids = await vault.accountActiveBatchIds(users[6]);
            const owed = await vault.requestOf(users[6], ids[0]);
            const before = await RSUP.balanceOf(users[6]);
            await vault.connect(signers.users[6]).claim([ids[0]], users[6]);
            expect((await RSUP.balanceOf(users[6])) - before).to.equal(owed);
        });
        it("Vault stays solvent", async () => {
            // every cooled batch was claimed in full, so no RSUP is left behind
            expect(await RSUP.balanceOf(vaultAddress)).to.equal(0n);
            expect(await vault.backlogOwed()).to.equal(0n);
            // accounting matches magicStaker
            await vault.sync();
            expect(await vault.recordedStake()).to.equal(await vault.currentStake());
            await expectSolvent(users);
        });
    });
});
