// usRSUP behaviour when magicStaker misbehaves, using MockMagicStaker for failure injection

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
const RSUP_WHALE = "0x6666666677B06CB55EbF802BB12f8876360f919c";
const TEAM = "0x000000000000000000000000000000000000a11c";
const REUSD = "0x57aB1E0003F623289CD798B1824Be09a793e4Bec";
const REUSD_HOLDER = "0xc522A6606BBA746d7960404F22a3DB936B6F4F50";
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

async function advance(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
}

describe("usRSUP (magicStaker failure handling)", function () {
    let mock, mockAddress, vault, vaultAddress, RSUP, team;
    let signers = [];
    let P1, P2, C, O1;
    const users = [
        "0x0000000000000000000000000000000000000031", // a
        "0x0000000000000000000000000000000000000032", // b
        "0x0000000000000000000000000000000000000033", // c
        "0x0000000000000000000000000000000000000034", // keeper
    ];

    async function period() {
        return (await mock.cooldownEpochs()) + 1n;
    }
    async function toCooldownEpoch() {
        while (!(await mock.isCooldownEpoch())) await advance(WEEK);
    }
    async function toNonCooldownEpoch() {
        if (await mock.isCooldownEpoch()) await advance(WEEK);
    }

    before(async function () {
        await loadFixture(setUpSmartContracts); // reset to the shared fork-start snapshot
        RSUP = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", "0x419905009e4656fdC02418C7Df35B1E61Ed5F726");
        await impersonateAccount(RSUP_WHALE);
        await setBalance(RSUP_WHALE, 10n * E18);
        const whale = await ethers.getSigner(RSUP_WHALE);
        await impersonateAccount(TEAM);
        await setBalance(TEAM, 10n * E18);
        team = await ethers.getSigner(TEAM);
        await RSUP.connect(whale).transfer(TEAM, 100n * E18);
        for (const i in users) {
            await impersonateAccount(users[i]);
            await setBalance(users[i], 10n * E18);
            signers[i] = await ethers.getSigner(users[i]);
            await RSUP.connect(whale).transfer(users[i], 10000n * E18);
        }

        mock = await (await ethers.getContractFactory("MockMagicStaker")).deploy();
        mockAddress = await mock.getAddress();
        vault = await (await ethers.getContractFactory("usRSUP")).connect(team).deploy(mockAddress);
        vaultAddress = await vault.getAddress();
        await RSUP.connect(team).approve(vaultAddress, ethers.MaxUint256);
        await vault.connect(team).initialize(10n * E18);

        await toNonCooldownEpoch();
        for (const i of [0, 1, 2]) {
            await RSUP.connect(signers[i]).approve(vaultAddress, ethers.MaxUint256);
            await vault.connect(signers[i]).deposit(10000n * E18, users[i]);
        }
    });

    afterEach(async function () {
        if (vault) await expectVaultSolvent(vault, mock, RSUP, users);
    });

    describe("A cooldown revert does not block withdrawal requests", () => {
        it("Queues a request outside the cooldown epoch", async () => {
            await toNonCooldownEpoch();
            P1 = await vault.pendingBatchId();
            await vault.connect(signers[0]).requestWithdraw(1000n * E18);
            expect(await vault.requestOf(users[0], P1)).to.be.gt(0n);
        });
        it("Cooldown-epoch request still succeeds while magicStaker.cooldown reverts", async () => {
            await toCooldownEpoch();
            await mock.setRevertCooldown(true);
            const backlogBefore = await vault.backlogOwed();
            const p1Before = (await vault.batches(P1)).owed;
            await vault.connect(signers[1]).requestWithdraw(1000n * E18);
            // queued in the overflow batch instead of reverting, and kept out of the pending batch
            O1 = await vault.overflowBatchId();
            expect(O1).to.not.equal(0n);
            expect(await vault.requestOf(users[1], O1)).to.be.gt(0n);
            expect(await vault.requestOf(users[1], P1)).to.equal(0n);
            expect((await vault.batches(P1)).owed).to.equal(p1Before);
            expect(await vault.backlogOwed()).to.equal(backlogBefore + (await vault.requestOf(users[1], O1)));
            expect(await vault.pendingBatchId()).to.equal(P1);
            // its stake is realized, so it can still be cooled this cycle once magicStaker recovers
            expect(await vault.estimatedClaimEpoch(O1)).to.equal((await mock.getEpoch()) + (await period()));
        });
        it("Keeper processing surfaces the magicStaker revert", async () => {
            await expect(vault.connect(signers[3]).processBacklog()).to.be.revertedWith("mock: cooldown");
        });
        it("Pending and overflow are cooled together once magicStaker accepts cooldowns again", async () => {
            await mock.setRevertCooldown(false);
            const p = await vault.batches(P1);
            const o = await vault.batches(O1);
            // the batches' fees are below the cap, so the keeper gets exactly their usRSUP value
            const fees = p.fees + o.fees;
            expect(await vault.convertToAssets(await vault.mevCap())).to.be.gt(fees);
            const expectedReward = await vault.convertToShares(fees);
            await expect(vault.connect(signers[3]).processBacklog())
                .to.emit(vault, "BacklogProcessed").withArgs(users[3], p.owed + o.owed, fees, expectedReward);
            expect(await vault.balanceOf(users[3])).to.equal(expectedReward);
            const maturity = (await mock.getEpoch()) + (await period());
            for (const id of [P1, O1]) {
                const b = await vault.batches(id);
                expect(b.maturityEpoch).to.equal(maturity);
            }
            expect(p.owed).to.equal(await vault.requestOf(users[0], P1));
            expect(await vault.overflowBatchId()).to.equal(0n);
            expect(await vault.backlogOwed()).to.equal(0n);

        });
    });

    describe("A backlog that cannot be cooled does not block requests that fit", () => {
        it("Queues a large request", async () => {
            await toNonCooldownEpoch();
            P2 = await vault.pendingBatchId();
            await vault.connect(signers[0]).requestWithdraw(2000n * E18);
        });
        it("Pending batch exceeds realized stake in the next cooldown epoch", async () => {
            await toCooldownEpoch();
            const [realized] = await mock.accountStakeData(vaultAddress);
            await mock.forcePending(vaultAddress, realized - 500n * E18);
            expect(await vault.availableToCooldown()).to.equal(500n * E18);
            expect((await vault.batches(P2)).owed).to.be.gt(500n * E18);
            await expect(vault.connect(signers[3]).processBacklog()).to.be.revertedWithCustomError(vault, "NothingToProcess");
            // it can't be cooled this cooldown epoch, so the estimate is the next cycle's maturity
            expect(await vault.estimatedClaimEpoch(P2)).to.equal((await mock.getEpoch()) + 2n * (await period()));
        });
        it("A request that fits is cooled immediately in its own batch", async () => {
            C = await vault.nextBatchId();
            await vault.connect(signers[2]).requestWithdraw(300n * E18);
            const c = await vault.batches(C);
            expect(await vault.requestOf(users[2], C)).to.equal(c.owed);
            expect(c.maturityEpoch).to.equal((await mock.getEpoch()) + (await period()));
            // the stuck batch is untouched and still queued
            expect((await vault.batches(P2)).maturityEpoch).to.equal(0n);
            expect(await vault.pendingBatchId()).to.equal(P2);
            expect(await vault.backlogOwed()).to.equal((await vault.batches(P2)).owed);
        });
        it("The cooldown also released the matured first batches into the vault", async () => {
            const p = await vault.batches(P1);
            const o = await vault.batches(O1);
            expect(await RSUP.balanceOf(vaultAddress)).to.equal(p.owed + o.owed);
        });
    });

    describe("Claims when magicStaker cannot release a matured cooldown", () => {
        it("Batch still held in magicStaker is not claimable, and cannot use other batches' RSUP", async () => {
            await advance(WEEK);
            await toCooldownEpoch(); // batch C matured, still held in magicStaker
            await mock.setRevertUnstake(true);
            const [held, heldMaturity] = await mock.accountCooldownData(vaultAddress);
            expect(held).to.be.gt(0n);
            expect(heldMaturity).to.equal((await vault.batches(C)).maturityEpoch);
            expect(await vault.claimable(users[2], C)).to.be.gt(0n);
            await expect(vault.connect(signers[2]).claim([C], users[2])).to.be.revertedWithCustomError(vault, "NotClaimable");
            expect(await vault.batchReleased(C)).to.equal(false);
            expect(await vault.batchReleased(P1)).to.equal(true);
            expect(await vault.batchReleased(P2)).to.equal(false); // not cooled yet
        });
        it("Batches already released remain claimable", async () => {
            for (const [i, id] of [[0, P1], [1, O1]]) {
                const owed = await vault.requestOf(users[i], id);
                const before = await RSUP.balanceOf(users[i]);
                await expect(vault.connect(signers[i]).claim([id], users[i]))
                    .to.emit(vault, "WithdrawClaimed").withArgs(users[i], users[i], id, owed);
                expect((await RSUP.balanceOf(users[i])) - before).to.equal(owed);
            }
            // nothing of batch C was spent
            expect(await RSUP.balanceOf(vaultAddress)).to.equal(0n);
        });
        it("Held batch becomes claimable once magicStaker releases it", async () => {
            await mock.setRevertUnstake(false);
            const owed = await vault.requestOf(users[2], C);
            const before = await RSUP.balanceOf(users[2]);
            await vault.connect(signers[2]).claim([C], users[2]);
            expect((await RSUP.balanceOf(users[2])) - before).to.equal(owed);
            expect(await vault.batchReleased(C)).to.equal(true);
            expect(await RSUP.balanceOf(vaultAddress)).to.equal(0n);
        });
        it("The previously stuck batch is processed in the next cooldown epoch", async () => {
            await vault.connect(signers[3]).processBacklog();
            const b = await vault.batches(P2);
            expect(b.maturityEpoch).to.equal((await mock.getEpoch()) + (await period()));
            expect(await vault.backlogOwed()).to.equal(0n);
        });
    });

    describe("Profit unlock schedule", () => {
        async function addYield(amount) {
            const whale = await ethers.getSigner(RSUP_WHALE);
            await RSUP.connect(whale).approve(mockAddress, ethers.MaxUint256);
            await mock.connect(whale).addYield(vaultAddress, amount);
            await vault.sync();
        }
        it("Starts from a fully unlocked state", async () => {
            await advance(WEEK);
            expect(await vault.lockedProfit()).to.equal(0n);
        });
        it("A single profit unlocks linearly over 7 days", async () => {
            await addYield(700n * E18);
            const start = await vault.lastProfitUpdate();
            expect(await vault.fullUnlockTime()).to.equal(start + BigInt(WEEK));
            await advance(WEEK / 2);
            expect(await vault.lockedProfit()).to.be.closeTo(350n * E18, 1n * E18);
        });
        it("Dust profits do not restart or delay the schedule", async () => {
            const end = await vault.fullUnlockTime();
            for (let i = 0; i < 20; i++) {
                await advance(3600);
                await addYield(1n);
            }
            // end moves by at most a few seconds, not a fresh 7 days
            expect(await vault.fullUnlockTime()).to.be.closeTo(end, 5n);
            const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
            await advance(Number(end - now) + 1);
            expect(await vault.lockedProfit()).to.be.lte(20n);
        });
        it("A second real profit extends the end by the amount-weighted average", async () => {
            await addYield(700n * E18); // fully unlocked before, so ends in 7 days
            const t0 = await vault.lastProfitUpdate();
            await advance(WEEK / 2);
            // schedule before the second profit; the expected result is computed at the exact recording time t1
            const oldStored = await vault.lockedProfitStored();
            const oldLast = await vault.lastProfitUpdate();
            const oldEnd = await vault.fullUnlockTime();
            await addYield(700n * E18);
            const t1 = await vault.lastProfitUpdate();
            const remaining = (oldStored * (oldEnd - t1)) / (oldEnd - oldLast);
            const remainingTime = oldEnd - t1;
            const expectedDuration = (remaining * remainingTime + 700n * E18 * BigInt(WEEK)) / (remaining + 700n * E18);
            expect((await vault.fullUnlockTime()) - t1).to.equal(expectedDuration);
            expect(t1 - t0).to.be.gte(BigInt(WEEK / 2));
            // everything is unlocked by the new end
            await advance(Number(expectedDuration) + 1);
            expect(await vault.lockedProfit()).to.equal(0n);
        });
        it("Share price never decreases while profit unlocks", async () => {
            await addYield(1000n * E18);
            let last = await vault.convertToAssets(E18);
            for (let i = 0; i < 8; i++) {
                await advance(WEEK / 7);
                if (i % 3 == 0) await addYield(1n);
                const now = await vault.convertToAssets(E18);
                expect(now).to.be.gte(last);
                last = now;
            }
        });
    });

    describe("Cooldown schedule changes", () => {
        it("A magicStaker maturity mismatch makes cooldown-week requests queue instead of reverting", async () => {
            await toCooldownEpoch();
            const epoch = await mock.getEpoch();
            // what magicStaker reports when governance changed cooldownEpochs mid-cycle (CooldownsPending)
            await mock.setPendingCooldownEpoch(epoch + 5n);
            expect(await vault.canCooldown()).to.equal(false);
            const pid = await vault.pendingBatchId();
            await vault.connect(signers[0]).requestWithdraw(100n * E18);
            expect(await vault.requestOf(users[0], pid)).to.be.gt(0n);
            expect((await vault.batches(pid)).maturityEpoch).to.equal(0n);
            await expect(vault.connect(signers[3]).processBacklog()).to.be.revertedWithCustomError(vault, "NotCooldownEpoch");
            // can't be processed this cooldown epoch, so the estimate moves to the next one
            expect(await vault.estimatedClaimEpoch(pid)).to.equal(epoch + 6n);
            await mock.setPendingCooldownEpoch(ethers.MaxUint256);
            expect(await vault.estimatedClaimEpoch(pid)).to.equal(epoch + 3n);
            await vault.connect(signers[3]).processBacklog();
            expect((await vault.batches(pid)).maturityEpoch).to.equal(epoch + 3n);
        });
        // previous test left a cooldown maturing at E0 + 3, cooled in cooldown epoch E0
        let E0, heldMaturity;
        it("After cooldownEpochs changes, never re-dates a cooldown that has not matured", async () => {
            E0 = await mock.getEpoch();
            [, heldMaturity] = await mock.accountCooldownData(vaultAddress);
            expect(heldMaturity).to.equal(E0 + 3n);
            await mock.setCooldownEpochs(0); // e.g. during a staker migration: every epoch, 1-epoch wait
            await advance(WEEK); // E0 + 1: next maturity would be E0 + 2, not E0 + 3
            expect(await mock.isCooldownEpoch()).to.equal(true);
            expect(await vault.canCooldown()).to.equal(false);
            const pid = await vault.pendingBatchId();
            await vault.connect(signers[1]).requestWithdraw(100n * E18);
            expect(await vault.requestOf(users[1], pid)).to.be.gt(0n); // queued, not cooled
            expect((await vault.batches(pid)).maturityEpoch).to.equal(0n);
        });
        it("Joins the existing cooldown when the maturities line up", async () => {
            await advance(WEEK); // E0 + 2: next maturity is E0 + 3, same as the held cooldown
            expect(await vault.canCooldown()).to.equal(true);
            const pid = await vault.pendingBatchId();
            await vault.connect(signers[3]).processBacklog();
            expect((await vault.batches(pid)).maturityEpoch).to.equal(heldMaturity);
        });
        it("Follows the new schedule once the old cooldown has matured", async () => {
            await advance(WEEK); // E0 + 3
            const epoch = await mock.getEpoch();
            const id = await vault.nextBatchId();
            await vault.connect(signers[1]).requestWithdraw(100n * E18);
            expect((await vault.batches(id)).maturityEpoch).to.equal(epoch + 1n);
            await mock.setCooldownEpochs(2);
        });
    });

    describe("Batches are cooled only in full", () => {
        let pid;
        it("A batch 1 wei over the realized stake waits for the next cycle", async () => {
            await advance(WEEK);
            await toNonCooldownEpoch();
            pid = await vault.pendingBatchId();
            await vault.connect(signers[2]).requestWithdraw(500n * E18);
            await toCooldownEpoch();
            const epoch = await mock.getEpoch();
            const owed = (await vault.batches(pid)).owed;
            await mock.forcePending(vaultAddress, (await vault.availableToCooldown()) - (owed - 1n));
            expect(await vault.availableToCooldown()).to.equal(owed - 1n);
            expect(await vault.estimatedClaimEpoch(pid)).to.equal(epoch + 2n * (await period()));
            await expect(vault.connect(signers[3]).processBacklog()).to.be.revertedWithCustomError(vault, "NothingToProcess");
            expect((await vault.batches(pid)).maturityEpoch).to.equal(0n);
        });
        it("A batch that exactly fits the realized stake is cooled in full", async () => {
            await advance(WEEK);
            await toCooldownEpoch();
            const owed = (await vault.batches(pid)).owed;
            await mock.forcePending(vaultAddress, (await vault.availableToCooldown()) - owed);
            expect(await vault.availableToCooldown()).to.equal(owed);
            await expect(vault.connect(signers[3]).processBacklog())
                .to.emit(vault, "BatchCooled").withArgs(pid, owed, (await mock.getEpoch()) + (await period()));
            expect(await vault.backlogOwed()).to.equal(0n);
        });
        it("Active set tracks only unclaimed batches", async () => {
            const active = await vault.accountActiveBatchIds(users[2]);
            expect(active).to.include(pid);
            for (const id of active) expect(await vault.requestOf(users[2], id)).to.be.gt(0n);
        });
        it("Claim pays exactly the RSUP owed at request time", async () => {
            const b = await vault.batches(pid);
            while ((await mock.getEpoch()) < b.maturityEpoch) await advance(WEEK);
            const owed = await vault.requestOf(users[2], pid);
            expect(await vault.claimable(users[2], pid)).to.equal(owed);
            const before = await RSUP.balanceOf(users[2]);
            await expect(vault.connect(signers[2]).claim([pid], users[2]))
                .to.emit(vault, "WithdrawClaimed").withArgs(users[2], users[2], pid, owed);
            expect((await RSUP.balanceOf(users[2])) - before).to.equal(owed);
            expect(await vault.accountActiveBatchIds(users[2])).to.not.include(pid);
        });
    });

    describe("Zero caps", () => {
        it("feeCap = 0 means no withdraw fee, though withdrawFee > 0", async () => {
            await vault.connect(team).setFeeCap(0);
            await advance(WEEK);
            await toNonCooldownEpoch();
            const pid = await vault.pendingBatchId();
            const shares = 100n * E18;
            const assets = await vault.convertToAssets(shares);
            const potBefore = await vault.feePot();
            await vault.connect(signers[1]).requestWithdraw(shares);
            expect(await vault.requestOf(users[1], pid)).to.equal(assets);
            expect(await vault.feePot()).to.equal(potBefore);
            await vault.connect(team).setFeeCap(25n * E18);
        });
        it("mevCap = 0 means no keeper reward; the fees stay with holders", async () => {
            await vault.connect(team).setMevCap(0);
            const pid = await vault.pendingBatchId();
            await vault.connect(signers[1]).requestWithdraw(100n * E18);
            const fees = (await vault.batches(pid)).fees;
            expect(fees).to.be.gt(0n); // the fee is still charged
            await toCooldownEpoch();
            const keeperBefore = await vault.balanceOf(users[3]);
            await expect(vault.connect(signers[3]).processBacklog())
                .to.emit(vault, "BacklogProcessed").withArgs(users[3], anyValue, fees, 0n);
            expect(await vault.balanceOf(users[3])).to.equal(keeperBefore); // no keeper reward
            await vault.connect(team).setMevCap(100n * E18);
        });
        it("Both caps bind: the fee is feeCap's value at the share price, the keeper gets mevCap, holders get the rest", async () => {
            await advance(WEEK);
            await toNonCooldownEpoch();
            expect(await vault.convertToAssets(E18)).to.be.gt(E18); // share price above 1, so feeCap's RSUP value differs from feeCap
            await vault.connect(team).setWithdrawFee(100); // 1%, so 500 usRSUP requests hit the cap
            await vault.connect(team).setFeeCap(E18);
            await vault.connect(team).setMevCap(E18);
            const pid = await vault.pendingBatchId();
            for (const i of [1, 2]) {
                const receipt = await (await vault.connect(signers[i]).requestWithdraw(500n * E18)).wait();
                const fee = receipt.logs.map((l) => vault.interface.parseLog(l)).find((e) => e?.name === "WithdrawRequested").args.fee;
                // capped at 1 usRSUP's value in RSUP: more than 1 RSUP, far less than 1% of 500
                expect(fee).to.be.gt(E18);
                expect(fee).to.be.closeTo(await vault.convertToAssets(E18), 10n ** 12n);
            }
            const fees = (await vault.batches(pid)).fees;
            await toCooldownEpoch();
            const keeperBefore = await vault.balanceOf(users[3]);
            const receipt = await (await vault.connect(signers[3]).processBacklog()).wait();
            const events = receipt.logs.map((l) => vault.interface.parseLog(l)).filter(Boolean);
            const processed = events.find((e) => e.name === "BacklogProcessed");
            expect(processed.args.fees).to.equal(fees);
            expect(processed.args.keeperShares).to.equal(E18); // fees are worth ~2 usRSUP, the keeper gets exactly mevCap
            expect((await vault.balanceOf(users[3])) - keeperBefore).to.equal(E18);
            // the rest of the fees becomes locked profit for holders
            const profit = events.find((e) => e.name === "ProfitRecorded").args.profit;
            expect(profit + (await vault.convertToAssets(E18))).to.be.closeTo(fees, 10n ** 12n);
            await vault.connect(team).setWithdrawFee(10);
            await vault.connect(team).setFeeCap(25n * E18);
            await vault.connect(team).setMevCap(100n * E18);
        });
        it("withdrawFee = 0 means no fee, with the caps still set", async () => {
            await vault.connect(team).setWithdrawFee(0);
            await toNonCooldownEpoch();
            const pid = await vault.pendingBatchId();
            const shares = 100n * E18;
            const assets = await vault.convertToAssets(shares);
            await vault.connect(signers[1]).requestWithdraw(shares);
            expect(await vault.requestOf(users[1], pid)).to.equal(assets);
            await vault.connect(team).setWithdrawFee(10);
        });
    });

    describe("Pausing deposits never blocks exits", () => {
        it("Requests, processing and claims all work while deposits are paused", async () => {
            await vault.connect(team).setPaused(true);
            await toNonCooldownEpoch();
            const pid = await vault.pendingBatchId();
            await vault.connect(signers[2]).requestWithdraw(100n * E18);
            await toCooldownEpoch();
            await vault.connect(signers[3]).processBacklog();
            const b = await vault.batches(pid);
            expect(b.maturityEpoch).to.be.gt(0n);
            while ((await mock.getEpoch()) < b.maturityEpoch) await advance(WEEK);
            const owed = await vault.requestOf(users[2], pid);
            const before = await RSUP.balanceOf(users[2]);
            await vault.connect(signers[2]).claim([pid], users[2]);
            expect((await RSUP.balanceOf(users[2])) - before).to.equal(owed);
            await expect(vault.connect(signers[0]).deposit(E18, users[0])).to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit");
            await vault.connect(team).setPaused(false);
        });
    });

    describe("Loss path", () => {
        it("A loss smaller than the locked profit is absorbed by it; the share price doesn't move", async () => {
            const whale = await ethers.getSigner(RSUP_WHALE);
            await RSUP.connect(whale).approve(mockAddress, ethers.MaxUint256);
            await mock.connect(whale).addYield(vaultAddress, 100n * E18);
            await vault.sync();
            const locked = await vault.lockedProfit();
            const pps = await vault.convertToAssets(E18);
            await mock.slash(vaultAddress, 40n * E18);
            await expect(vault.sync()).to.emit(vault, "LossRecorded").withArgs(40n * E18);
            expect(await vault.lockedProfit()).to.be.closeTo(locked - 40n * E18, E18 / 1000n);
            expect(await vault.convertToAssets(E18)).to.be.closeTo(pps, 10n ** 12n);
            expect(await vault.recordedStake()).to.equal(await vault.currentStake());
        });
        it("A loss larger than the locked profit lowers the share price", async () => {
            const locked = await vault.lockedProfit();
            const pps = await vault.convertToAssets(E18);
            await mock.slash(vaultAddress, locked + 100n * E18);
            await vault.sync();
            expect(await vault.lockedProfit()).to.equal(0n);
            expect(await vault.convertToAssets(E18)).to.be.lt(pps);
        });
    });

    describe("execute", () => {
        it("Is owner-only, emits Executed on success and reverts when the call fails", async () => {
            const data = mock.interface.encodeFunctionData("setRevertCooldown", [false]);
            await expect(vault.connect(signers[0]).execute(mockAddress, 0, data)).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
            await expect(vault.connect(team).execute(mockAddress, 0, data)).to.emit(vault, "Executed").withArgs(mockAddress, 0, data, true);
            const failing = RSUP.interface.encodeFunctionData("transfer", [TEAM, 10n ** 30n]); // more than the vault holds
            await expect(vault.connect(team).execute(await RSUP.getAddress(), 0, failing)).to.be.revertedWith("execute failed");
        });
    });

    describe("Quorum boost branches (mock voter)", () => {
        let mv;
        async function now() { return BigInt((await ethers.provider.getBlock("latest")).timestamp); }
        before(async () => {
            mv = await (await ethers.getContractFactory("MockMagicVoter")).deploy();
            await mock.setMagicVoter(await mv.getAddress());
            await mock.setPowers(1000n * E18, 500n * E18); // 500 non-vault, 500 vault
        });
        it("Reverts when magicVoter says voting has ended", async () => {
            await mv.setProposal(false, Number((await now()) - 86400n * 3n), 86400, 60n * E18, 0, true);
            await expect(vault.boostQuorum(1)).to.be.revertedWith("!canVote");
        });
        it("Reverts before magicVoter's delay and before boostDelay", async () => {
            await mv.setProposal(true, Number(await now()), 86400, 60n * E18, 0, true);
            await expect(vault.boostQuorum(1)).to.be.revertedWithCustomError(vault, "BoostTooEarly");
            await mv.setProposal(true, Number((await now()) - 86400n * 2n), 86400, 60n * E18, 0, true);
            await vault.connect(team).setBoostDelay(3n * 86400n);
            await expect(vault.boostQuorum(1)).to.be.revertedWithCustomError(vault, "BoostTooEarly");
            await vault.connect(team).setBoostDelay(0);
        });
        it("Reverts with no votes, or below the quorum of non-vault power", async () => {
            const createdAt = Number((await now()) - 86400n * 3n);
            await mv.setProposal(true, createdAt, 86400, 0, 0, true);
            await expect(vault.boostQuorum(1)).to.be.revertedWithCustomError(vault, "QuorumNotMet");
            await mv.setProposal(true, createdAt, 86400, 40n * E18, 0, true); // 8% < 10%
            await expect(vault.boostQuorum(1)).to.be.revertedWithCustomError(vault, "QuorumNotMet");
        });
        it("Reverts when the vault has no voting power", async () => {
            await mock.setPowers(1000n * E18, 0);
            await mv.setProposal(true, Number((await now()) - 86400n * 3n), 86400, 200n * E18, 0, true);
            await expect(vault.boostQuorum(1)).to.be.revertedWith("!power");
            await mock.setPowers(1000n * E18, 500n * E18);
        });
        it("Reverts if the vote doesn't commit in the same transaction", async () => {
            await mv.setProposal(true, Number((await now()) - 86400n * 3n), 86400, 60n * E18, 0, false);
            await expect(vault.boostQuorum(1)).to.be.revertedWithCustomError(vault, "NotCommitted");
        });
        it("Mirrors a mixed yes/no split exactly", async () => {
            await mv.setProposal(true, Number((await now()) - 86400n * 3n), 86400, 45n * E18, 15n * E18, true); // 12%
            await expect(vault.boostQuorum(1)).to.emit(vault, "QuorumBoosted").withArgs(1, 7500, 2500, 500n * E18);
            expect(await mv.lastPctYes()).to.equal(7500n);
            expect(await mv.lastPctNo()).to.equal(2500n);
        });
    });

    describe("Overflow eligibility while magicStaker rejects cooldowns", () => {
        let O, P, E2;
        it("Creates an overflow batch that is due next cycle, and a pending batch", async () => {
            await advance(WEEK);
            await toCooldownEpoch();
            const [realized] = await mock.accountStakeData(vaultAddress);
            await mock.forcePending(vaultAddress, realized - E18); // almost nothing realized this epoch
            await vault.connect(signers[0]).requestWithdraw(500n * E18); // too large -> overflow
            O = await vault.overflowBatchId();
            expect(await vault.overflowEpoch()).to.equal(await mock.getEpoch());
            await advance(WEEK); // a normal week
            P = await vault.pendingBatchId();
            await vault.connect(signers[2]).requestWithdraw(100n * E18);
        });
        it("A request rejected by magicStaker joins the due overflow batch without pushing it back", async () => {
            await toCooldownEpoch();
            E2 = await mock.getEpoch();
            const overflowEpochBefore = await vault.overflowEpoch();
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E2 + (await period()));
            await mock.setRevertCooldown(true);
            await vault.connect(signers[1]).requestWithdraw(100n * E18);
            expect(await vault.requestOf(users[1], O)).to.be.gt(0n);
            expect(await vault.overflowEpoch()).to.equal(overflowEpochBefore);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E2 + (await period()));
        });
        it("Once magicStaker recovers, the keeper cools pending and overflow together this cycle", async () => {
            await mock.setRevertCooldown(false);
            const p = await vault.batches(P);
            const o = await vault.batches(O);
            const fees = p.fees + o.fees;
            const cap = await vault.mevCap();
            const feeShares = await vault.convertToShares(fees);
            const expectedReward = feeShares < cap ? feeShares : cap;
            await expect(vault.connect(signers[3]).processBacklog())
                .to.emit(vault, "BacklogProcessed").withArgs(users[3], p.owed + o.owed, fees, expectedReward);
            for (const id of [P, O]) expect((await vault.batches(id)).maturityEpoch).to.equal(E2 + (await period()));
            expect(await vault.backlogOwed()).to.equal(0n);
            expect(await vault.feePot()).to.equal(0n);
        });
        it("A fresh overflow batch from a rejected request that fits is also coolable this cycle", async () => {
            await mock.setRevertCooldown(true);
            await vault.connect(signers[2]).requestWithdraw(50n * E18);
            const O2 = await vault.overflowBatchId();
            expect(await vault.overflowEpoch()).to.equal(E2 - 1n);
            expect(await vault.estimatedClaimEpoch(O2)).to.equal(E2 + (await period()));
            await mock.setRevertCooldown(false);
            await vault.connect(signers[3]).processBacklog();
            expect((await vault.batches(O2)).maturityEpoch).to.equal(E2 + (await period()));
        });
    });

    describe("Overflow labelling and processing order", () => {
        let E, E3, P, O, per;
        // make exactly `x` of the vault's stake coolable this epoch (the rest becomes unrealized)
        async function setAvailable(x) {
            const available = await vault.availableToCooldown();
            await mock.forcePending(vaultAddress, available - x);
            expect(await vault.availableToCooldown()).to.equal(x);
        }
        it("A rejected request that fits alone but not behind the pending batch waits a cycle (L-01)", async () => {
            per = await period();
            await advance(WEEK);
            await toNonCooldownEpoch();
            P = await vault.pendingBatchId();
            await vault.connect(signers[0]).requestWithdraw(300n * E18);
            await toCooldownEpoch();
            E = await mock.getEpoch();
            const pOwed = (await vault.batches(P)).owed;
            await setAvailable(pOwed + 100n * E18); // the pending batch fits, leaving 100
            await mock.setRevertCooldown(true);
            await vault.connect(signers[1]).requestWithdraw(200n * E18); // ~200: fits alone, not behind pending
            O = await vault.overflowBatchId();
            expect(await vault.overflowEpoch()).to.equal(E);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E + 2n * per);
            await mock.setRevertCooldown(false);
            await vault.connect(signers[3]).processBacklog();
            expect((await vault.batches(P)).maturityEpoch).to.equal(E + per);
            expect((await vault.batches(O)).maturityEpoch).to.equal(0n);
        });
        it("A request joining an overflow batch that already has to wait doesn't make it coolable", async () => {
            await mock.setRevertCooldown(true);
            await vault.connect(signers[2]).requestWithdraw(10n * E18); // fits behind the (now empty) queue
            expect(await vault.requestOf(users[2], O)).to.be.gt(0n);
            expect(await vault.overflowEpoch()).to.equal(E);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E + 2n * per);
            await mock.setRevertCooldown(false);
        });
        it("When the pending batch uses up the stake, the overflow batch waits and its estimate says so", async () => {
            await advance(WEEK);
            const P2 = await vault.pendingBatchId();
            await vault.connect(signers[0]).requestWithdraw(2000n * E18);
            await toCooldownEpoch();
            E3 = await mock.getEpoch();
            expect(await vault.overflowEpoch()).to.be.lt(E3); // eligible now
            await setAvailable((await vault.batches(P2)).owed + 10n * E18); // pending fits, overflow doesn't
            expect(await vault.estimatedClaimEpoch(P2)).to.equal(E3 + per);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E3 + 2n * per);
            await vault.connect(signers[3]).processBacklog();
            expect((await vault.batches(P2)).maturityEpoch).to.equal(E3 + per);
            expect((await vault.batches(O)).maturityEpoch).to.equal(0n);
        });
        it("A request that doesn't fit behind the queue pushes the overflow batch back (documented)", async () => {
            expect(await vault.overflowEpoch()).to.be.lt(E3);
            await vault.connect(signers[1]).requestWithdraw(50n * E18); // more than the ~10 left
            expect(await vault.requestOf(users[1], O)).to.be.gt(0n);
            expect(await vault.overflowEpoch()).to.equal(E3);
        });
        it("When the pending batch doesn't fit, a coolable overflow batch is still cooled", async () => {
            await advance(WEEK);
            const P3 = await vault.pendingBatchId();
            await vault.connect(signers[0]).requestWithdraw(2000n * E18);
            await toCooldownEpoch();
            const E6 = await mock.getEpoch();
            await setAvailable((await vault.batches(O)).owed + 10n * E18); // overflow fits, pending (2000) doesn't
            expect(await vault.estimatedClaimEpoch(P3)).to.equal(E6 + 2n * per);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E6 + per);
            await vault.connect(signers[3]).processBacklog();
            expect((await vault.batches(O)).maturityEpoch).to.equal(E6 + per);
            expect((await vault.batches(P3)).maturityEpoch).to.equal(0n);
        });
    });

    describe("Cooldown-week requests and the cumulative overflow check", () => {
        let per;
        async function setAvailable(x) {
            const available = await vault.availableToCooldown();
            await mock.forcePending(vaultAddress, available - x);
            expect(await vault.availableToCooldown()).to.equal(x);
        }
        it("A cooldown-week request processes the backlog itself, with no keeper reward", async () => {
            per = await period();
            await advance(WEEK);
            await toNonCooldownEpoch();
            const P = await vault.pendingBatchId();
            await vault.connect(signers[2]).requestWithdraw(30n * E18);
            await toCooldownEpoch();
            expect(await vault.overflowBatchId()).to.equal(0n);
            const p = await vault.batches(P);
            const supplyBefore = await vault.totalSupply();
            const tx = vault.connect(signers[1]).requestWithdraw(10n * E18);
            await expect(tx).to.emit(vault, "BacklogProcessed").withArgs(ethers.ZeroAddress, p.owed, p.fees, 0n);
            await expect(tx).to.emit(vault, "ProfitRecorded").withArgs(p.fees, anyValue);
            // only the requester's shares were burned: nothing minted to a keeper
            expect(await vault.totalSupply()).to.equal(supplyBefore - 10n * E18);
            expect((await vault.batches(P)).maturityEpoch).to.equal((await mock.getEpoch()) + per);
            expect(await vault.feePot()).to.equal(0n);
            expect(await vault.backlogOwed()).to.equal(0n);
        });
        it("A cooldown-week request 1 wei over the realized stake goes to overflow, not a short cooldown", async () => {
            const E = await mock.getEpoch();
            const shares = E18 / 100n;
            const assets = await vault.convertToAssets(shares);
            const feeByRate = (assets * (await vault.withdrawFee()) + 9999n) / 10000n;
            const feeCap = await vault.convertToAssets(await vault.feeCap());
            // the share price only rises before the request mines, so the request is at least 1 wei over
            await setAvailable(assets - (feeByRate < feeCap ? feeByRate : feeCap) - 1n);
            await vault.connect(signers[1]).requestWithdraw(shares);
            const O = await vault.overflowBatchId();
            expect(O).to.not.equal(0n);
            expect(await vault.requestOf(users[1], O)).to.be.gt(0n);
            expect(await vault.overflowEpoch()).to.equal(E);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E + 2n * per);
            // cooled in full next cycle
            await advance(WEEK);
            await toCooldownEpoch();
            await vault.connect(signers[3]).processBacklog();
            expect((await vault.batches(O)).maturityEpoch).to.equal(E + 2n * per);
            expect(await vault.overflowBatchId()).to.equal(0n);
        });
        it("A cooldown-week request that exactly uses up the realized stake is cooled immediately", async () => {
            // a cycle with no new profit, so the share price is static and owed is known exactly in advance
            await advance(WEEK);
            await toCooldownEpoch();
            expect(await vault.lockedProfit()).to.equal(0n);
            expect(await vault.overflowBatchId()).to.equal(0n);
            expect((await vault.batches(await vault.pendingBatchId())).owed).to.equal(0n);
            const shares = 10n * E18;
            const assets = await vault.convertToAssets(shares);
            const feeByRate = (assets * (await vault.withdrawFee()) + 9999n) / 10000n;
            const feeCap = await vault.convertToAssets(await vault.feeCap());
            const owed = assets - (feeByRate < feeCap ? feeByRate : feeCap);
            await setAvailable(owed);
            const id = await vault.nextBatchId();
            await expect(vault.connect(signers[1]).requestWithdraw(shares))
                .to.emit(vault, "BatchCooled").withArgs(id, owed, (await mock.getEpoch()) + per);
            expect(await vault.requestOf(users[1], id)).to.equal(owed);
            expect(await vault.availableToCooldown()).to.equal(0n);
            expect(await vault.overflowBatchId()).to.equal(0n);
        });
        it("A rejected request that fits behind the pending batch, but not behind a coolable overflow batch too, pushes it back", async () => {
            await advance(WEEK);
            await toNonCooldownEpoch();
            const P = await vault.pendingBatchId();
            await vault.connect(signers[2]).requestWithdraw(100n * E18);
            await toCooldownEpoch();
            const E = await mock.getEpoch();
            expect(await vault.overflowBatchId()).to.equal(0n);
            await setAvailable((await vault.batches(P)).owed + 150n * E18); // pending fits, leaving 150
            await mock.setRevertCooldown(true);
            await vault.connect(signers[1]).requestWithdraw(100n * E18); // ~100 fits behind pending
            const O = await vault.overflowBatchId();
            expect(await vault.overflowEpoch()).to.equal(E - 1n);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E + per);
            await vault.connect(signers[2]).requestWithdraw(100n * E18); // ~100 alone fits, ~200 together doesn't
            expect(await vault.requestOf(users[2], O)).to.be.gt(0n);
            expect(await vault.overflowEpoch()).to.equal(E);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E + 2n * per);
            await mock.setRevertCooldown(false);
            await vault.connect(signers[3]).processBacklog();
            expect((await vault.batches(P)).maturityEpoch).to.equal(E + per);
            expect((await vault.batches(O)).maturityEpoch).to.equal(0n);
        });
        it("A request too large to fit pushes back an overflow batch a rejection made coolable", async () => {
            await advance(WEEK);
            await toCooldownEpoch();
            const E = await mock.getEpoch();
            await vault.connect(signers[3]).processBacklog(); // clears the waiting overflow batch
            expect(await vault.overflowBatchId()).to.equal(0n);
            await mock.setRevertCooldown(true);
            await vault.connect(signers[1]).requestWithdraw(20n * E18);
            const O = await vault.overflowBatchId();
            expect(await vault.overflowEpoch()).to.equal(E - 1n);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E + per);
            await setAvailable((await vault.batches(O)).owed + 5n * E18);
            await vault.connect(signers[2]).requestWithdraw(50n * E18); // larger than the 5 left
            expect(await vault.requestOf(users[2], O)).to.be.gt(0n);
            expect(await vault.overflowEpoch()).to.equal(E);
            expect(await vault.estimatedClaimEpoch(O)).to.equal(E + 2n * per);
            await mock.setRevertCooldown(false);
        });
    });

    describe("harvest() reward forwarding", () => {
        it("Passes on only the harvest's reward-token fees, never RSUP or usRSUP", async () => {
            const reUSD = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", REUSD);
            await impersonateAccount(REUSD_HOLDER);
            await setBalance(REUSD_HOLDER, 10n * E18);
            await reUSD.connect(await ethers.getSigner(REUSD_HOLDER)).transfer(mockAddress, 10n * E18);
            // the mock lists RSUP and usRSUP as reward tokens too, and pays 1 RSUP as a "fee"
            await mock.setRewards([await RSUP.getAddress(), REUSD, vaultAddress]);
            await mock.setHarvestFee(await RSUP.getAddress(), E18);
            await mock.setHarvestFee(REUSD, 2n * E18);
            const rsupVaultBefore = await RSUP.balanceOf(vaultAddress);
            const rsupCallerBefore = await RSUP.balanceOf(users[3]);
            await expect(vault.connect(signers[3]).harvest()).to.emit(vault, "HarvestForwarded").withArgs(users[3], REUSD, 2n * E18);
            expect(await reUSD.balanceOf(users[3])).to.equal(2n * E18);
            expect(await RSUP.balanceOf(users[3])).to.equal(rsupCallerBefore); // RSUP is never forwarded
            expect((await RSUP.balanceOf(vaultAddress)) - rsupVaultBefore).to.equal(E18); // stays as stray RSUP
            await mock.setRewards([]);
        });
    });
});
