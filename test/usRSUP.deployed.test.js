// Post-deployment check: attaches to the DEPLOYED usRSUP and its Curve pool on a mainnet fork (no new deployments),
// runs the usRSUP.md deployment checks, wires the pool if the vault isn't wired yet, and runs a full cycle with fresh
// users: routed deposit, Curve sell, queued request, keeper processing, cooldown-week request, claims.

var { ethers } = require("hardhat");
var { expect } = require("chai");
var { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
var { setUpSmartContracts, expectVaultSolvent } = require("./fixtures");
const { impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

const WEEK = 7 * 24 * 60 * 60;
const E18 = 10n ** 18n;

const USRSUP = "0xF25cA1371D640bDaD2fE8958121eB393E61C56bb";
const POOL = "0x5c9da6af8fc95d50c20dba11c4d0a773bc480217";
const RSUP_ADDR = "0x419905009e4656fdC02418C7Df35B1E61Ed5F726";
const LIVE_MAGIC_STAKER = "0x64199056cAFF992227ff7c6f544F238b65141990";
const CURVE_NG_FACTORY = "0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf";
const RESUPPLY_CORE = "0xc07e000044F95655c11fda4cD37F70A94d7e0a7d";
const RSUP_WHALE = "0x6666666677B06CB55EbF802BB12f8876360f919c";
const DEPLOYER = "0xdC7C7F0bEA8444c12ec98Ec626ff071c6fA27a19";

const factoryAbi = [
    "function find_pool_for_coins(address,address,uint256) view returns (address)",
    "function get_pool_asset_types(address) view returns (uint8[])",
];
const poolAbi = [
    "function N_COINS() view returns (uint256)",
    "function coins(uint256) view returns (address)",
    "function A() view returns (uint256)",
    "function fee() view returns (uint256)",
    "function offpeg_fee_multiplier() view returns (uint256)",
    "function ma_exp_time() view returns (uint256)",
    "function stored_rates() view returns (uint256[])",
    "function balances(uint256) view returns (uint256)",
    "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
];

async function advance(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
}

describe("usRSUP (deployed contracts)", function () {
    let vault, pool, factory, MagicStaker, RSUP, owner, keeper;
    const signers = [];
    const users = [
        "0x0000000000000000000000000000000000000d01",
        "0x0000000000000000000000000000000000000d02",
        "0x0000000000000000000000000000000000000d03",
        "0x0000000000000000000000000000000000000d04",
    ];
    let queuedBatch, immediateBatch, period;
    const expectSolvent = (accounts) => expectVaultSolvent(vault, MagicStaker, RSUP, accounts);

    async function toCooldownEpoch() {
        while (!(await MagicStaker.isCooldownEpoch())) await advance(WEEK);
    }
    async function toNonCooldownEpoch() {
        if (await MagicStaker.isCooldownEpoch()) await advance(WEEK);
    }
    async function expectedFee(assets) {
        const byRate = (assets * (await vault.withdrawFee()) + 9999n) / 10000n;
        const cap = await vault.convertToAssets(await vault.feeCap());
        return byRate < cap ? byRate : cap;
    }

    before(async function () {
        await loadFixture(setUpSmartContracts); // fresh fork of current mainnet
        const forkBlock = await ethers.provider.getBlockNumber();
        if ((await ethers.provider.getCode(POOL)) === "0x" || (await ethers.provider.getCode(USRSUP)) === "0x") {
            throw new Error(`fork block ${forkBlock} predates the deployment; re-run in a minute (Hardhat forks a few blocks behind the head)`);
        }
        vault = await ethers.getContractAt("usRSUP", USRSUP);
        pool = new ethers.Contract(POOL, poolAbi, ethers.provider);
        factory = new ethers.Contract(CURVE_NG_FACTORY, factoryAbi, ethers.provider);
        MagicStaker = await ethers.getContractAt("magicStaker", LIVE_MAGIC_STAKER);
        RSUP = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", RSUP_ADDR);

        const ownerAddress = await vault.owner();
        await impersonateAccount(ownerAddress);
        await setBalance(ownerAddress, 10n * E18);
        owner = await ethers.getSigner(ownerAddress);

        await impersonateAccount(RSUP_WHALE);
        await setBalance(RSUP_WHALE, 10n * E18);
        const whale = await ethers.getSigner(RSUP_WHALE);
        for (const i in users) {
            await impersonateAccount(users[i]);
            await setBalance(users[i], 10n * E18);
            signers[i] = await ethers.getSigner(users[i]);
            await RSUP.connect(whale).transfer(users[i], 20000n * E18);
            await RSUP.connect(signers[i]).approve(USRSUP, ethers.MaxUint256);
        }
        keeper = signers[3];
        const rsupStaker = await ethers.getContractAt(["function cooldownEpochs() view returns (uint256)"], await MagicStaker.staker());
        period = (await rsupStaker.cooldownEpochs()) + 1n;
    });

    describe("Deployment checks (usRSUP.md)", () => {
        it("Vault is the expected contract and configuration", async () => {
            expect(await vault.name()).to.equal("Unofficial Staked RSUP");
            expect(await vault.symbol()).to.equal("usRSUP");
            expect(await vault.asset()).to.equal(RSUP_ADDR);
            expect(await vault.magicStaker()).to.equal(LIVE_MAGIC_STAKER);
            expect([DEPLOYER, RESUPPLY_CORE]).to.include(await vault.owner());
            expect(await MagicStaker.accountStrategyWeight(USRSUP, 0)).to.equal(10000n);
            expect(await vault.initialized()).to.equal(true);
            expect(await vault.balanceOf(await vault.DEAD())).to.equal(10n * E18);
            expect(await vault.pricePerShare()).to.be.gte(E18);
            expect(await vault.paused()).to.equal(false);
            expect(await vault.withdrawFee()).to.equal(10n);
            expect(await vault.feeCap()).to.equal(25n * E18);
            expect(await vault.mevCap()).to.equal(100n * E18);
            await expectSolvent([]);
        });
        it("Pool is the expected stableswap-ng pool", async () => {
            expect(await factory.find_pool_for_coins(RSUP_ADDR, USRSUP, 0)).to.equal(ethers.getAddress(POOL));
            expect(await factory.get_pool_asset_types(POOL)).to.deep.equal([0n, 3n]);
            expect(await pool.N_COINS()).to.equal(2n);
            expect(await pool.coins(0)).to.equal(RSUP_ADDR);
            expect(await pool.coins(1)).to.equal(USRSUP);
            expect(await pool.A()).to.equal(50n);
            expect(await pool.fee()).to.equal(10000000n);
            expect(await pool.offpeg_fee_multiplier()).to.equal(20000000000n);
            expect(await pool.ma_exp_time()).to.equal(2597n);
            expect((await pool.stored_rates())[1]).to.equal(await vault.pricePerShare());
            expect(await pool.balances(0)).to.be.gt(0n);
            expect(await pool.balances(1)).to.be.gt(0n);
        });
        it("Owner wires the pool (on the fork, if not done yet)", async () => {
            if ((await vault.curvePool()) === ethers.ZeroAddress) {
                await expect(vault.connect(owner).setCurvePool(POOL)).to.emit(vault, "CurvePoolSet").withArgs(ethers.getAddress(POOL));
            }
            expect(await vault.curvePool()).to.equal(ethers.getAddress(POOL));
            expect(await vault.poolRsupIndex()).to.equal(0n);
            expect(await vault.poolTokenIndex()).to.equal(1n);
        });
    });

    describe("Full cycle against the deployed contracts", () => {
        it("A minted deposit gets usRSUP at the share price", async () => {
            const assets = 6000n * E18;
            const expected = await vault.previewDeposit(assets);
            await vault.connect(signers[0]).depositWithRoute(assets, 0n, expected, users[0]);
            expect(await vault.balanceOf(users[0])).to.equal(expected);
            await expectSolvent(users);
        });
        it("Selling on Curve pays the pool's quote, in one transaction", async () => {
            const shares = 5000n * E18;
            const quote = await pool.get_dy(1, 0, shares);
            const before = await RSUP.balanceOf(users[0]);
            await vault.connect(signers[0]).withdrawViaCurve(shares, quote, users[0]);
            expect((await RSUP.balanceOf(users[0])) - before).to.equal(quote);
            expect(quote).to.be.lt(await vault.convertToAssets(shares)); // the sale leaves usRSUP at a discount
        });
        it("A routed deposit buys the discounted usRSUP on Curve and beats minting", async () => {
            const assets = 3000n * E18;
            const swap = 2000n * E18;
            expect(await pool.get_dy(0, 1, swap)).to.be.gt(await vault.previewDeposit(swap));
            const mintOnly = await vault.previewDeposit(assets);
            const tx = vault.connect(signers[1]).depositWithRoute(assets, swap, mintOnly, users[1]);
            await expect(tx).to.emit(vault, "RoutedDeposit");
            const receipt = await (await tx).wait();
            const ev = receipt.logs.map((l) => { try { return vault.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "RoutedDeposit");
            expect(ev.args.swapped).to.equal(swap);
            expect(await vault.balanceOf(users[1])).to.be.gt(mintOnly);
            await expectSolvent(users);
        });
        it("An off-week request is queued with the expected fee and claim epoch", async () => {
            await toNonCooldownEpoch();
            await vault.connect(signers[2]).depositWithRoute(2000n * E18, 0n, 0n, users[2]);
            queuedBatch = await vault.pendingBatchId();
            const shares = 1000n * E18;
            const assets = await vault.convertToAssets(shares);
            const fee = await expectedFee(assets);
            await vault.connect(signers[2]).requestWithdraw(shares);
            expect(await vault.requestOf(users[2], queuedBatch)).to.equal(assets - fee);
            const epoch = await MagicStaker.getEpoch();
            const nextCooldown = (epoch / period + 1n) * period;
            expect(await vault.estimatedClaimEpoch(queuedBatch)).to.equal(nextCooldown + period);
            await expectSolvent(users);
        });
        it("A keeper processes the queue in the cooldown week and is paid the fees, up to mevCap", async () => {
            await toCooldownEpoch();
            const fees = await vault.feePot();
            const owed = (await vault.batches(queuedBatch)).owed;
            const feeShares = await vault.convertToShares(fees);
            const cap = await vault.mevCap();
            const reward = feeShares < cap ? feeShares : cap;
            await expect(vault.connect(keeper).processBacklog())
                .to.emit(vault, "BacklogProcessed").withArgs(ethers.getAddress(users[3]), owed, fees, reward);
            expect(await vault.balanceOf(users[3])).to.equal(reward);
            expect((await vault.batches(queuedBatch)).maturityEpoch).to.equal((await MagicStaker.getEpoch()) + period);
            await expectSolvent(users);
        });
        it("A cooldown-week request is cooled immediately in its own batch", async () => {
            immediateBatch = await vault.nextBatchId();
            await vault.connect(signers[1]).requestWithdraw(500n * E18);
            expect((await vault.batches(immediateBatch)).maturityEpoch).to.equal((await MagicStaker.getEpoch()) + period);
            await expectSolvent(users);
        });
        it("Both withdrawals claim exactly what was owed once matured", async () => {
            const maturity = (await vault.batches(queuedBatch)).maturityEpoch;
            while ((await MagicStaker.getEpoch()) < maturity) await advance(WEEK);
            for (const [i, id] of [[2, queuedBatch], [1, immediateBatch]]) {
                const owed = await vault.requestOf(users[i], id);
                expect(await vault.claimable(users[i], id)).to.equal(owed);
                const before = await RSUP.balanceOf(users[i]);
                await vault.connect(signers[i]).claim([id], users[i]);
                expect((await RSUP.balanceOf(users[i])) - before).to.equal(owed);
                expect(await vault.accountActiveBatchIds(users[i])).to.not.include(id);
            }
            await expectSolvent(users);
        });
        it("The share price never fell", async () => {
            expect(await vault.pricePerShare()).to.be.gte(E18);
        });
    });
});
