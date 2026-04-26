// TO-DO: test excluded address cutoff

var { ethers } = require("hardhat");
var { expect } = require("chai");
var { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
var { setUpSmartContracts } = require("./fixtures");
const {
  impersonateAccount,
  setBalance,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("Setup", function () {

    // contracts and address variables used in tests
    let MagicPounder, MagicVoter, MagicStaker, MagicHarvester, MagicSavings;
    let MagicPounderAddress, MagicVoterAddress, MagicStakerAddress, MagicHarvesterAddress, MagicSavingsAddress, manager, operator;
    let reUSD, RSUP, sreUSD, staker, voter, create2Factory;
    let reUSDAddress, RSUPAddress, sreUSDAddress, stakerAddress, voterAddress, create2FactoryAddress, registryAddress;
    let signers = {users:[]}
    let users = [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        "0x0000000000000000000000000000000000000003",
        "0x0000000000000000000000000000000000000004",
        "0x0000000000000000000000000000000000000005",
        "0x0000000000000000000000000000000000000006",
        "0x0000000000000000000000000000000000000007",
        "0x0000000000000000000000000000000000000008",
        "0x0000000000000000000000000000000000000009",
    ];

    let depl = "0xB4421830226F9C5Ff32060B96a3b9F8D2E0E132D";
    let keyless = "0xF82eE5f5c44855C5B3953e117E9765FcDF318c3A";
    let core = "0xc07e000044F95655c11fda4cD37F70A94d7e0a7d";


    // Fund test accounts and get contract instances
    // setup signers for impersonated accounts
    before(async function () {
        // Load fixtures
        ({ MagicPounder, MagicVoter, MagicStaker, MagicHarvester, MagicSavings, manager, operator, reUSD, RSUP, sreUSD, staker, voter, create2Factory, registry } = await loadFixture(setUpSmartContracts));
        
        // Get deployed contract addresses
        MagicPounderAddress = await MagicPounder.getAddress();
        MagicVoterAddress = await MagicVoter.getAddress();
        MagicStakerAddress = await MagicStaker.getAddress();
        MagicHarvesterAddress = await MagicHarvester.getAddress();
        MagicSavingsAddress = await MagicSavings.getAddress();
        reUSDAddress = await reUSD.getAddress();
        RSUPAddress = await RSUP.getAddress();
        sreUSDAddress = await sreUSD.getAddress();
        stakerAddress = await staker.getAddress();
        voterAddress = await voter.getAddress();
        create2FactoryAddress = await create2Factory.getAddress();
        registryAddress = await registry.getAddress();

        // Impersonate and fund manager and operator accounts
        await impersonateAccount(manager);
        signers.manager = await ethers.getSigner(manager);
        await setBalance(manager, ethers.toBigInt("10000000000000000000"));

        await impersonateAccount(operator);
        signers.operator = await ethers.getSigner(operator);
        await setBalance(operator, ethers.toBigInt("10000000000000000000"));

        // Impersonate and fund reUSD and RSUP whales, distribute tokens to test users
        var reUSDwhale = "0xc522A6606BBA746d7960404F22a3DB936B6F4F50";
        await impersonateAccount(reUSDwhale);
        signers.reUSDwhale = await ethers.getSigner(reUSDwhale);
        await setBalance(reUSDwhale, ethers.toBigInt("10000000000000000000"));
        await reUSD.connect(signers.reUSDwhale).transfer(operator, 100000n*10n**18n);

        var RSUPwhale = "0x6666666677B06CB55EbF802BB12f8876360f919c";
        await impersonateAccount(RSUPwhale);
        signers.RSUPwhale = await ethers.getSigner(RSUPwhale);
        await setBalance(RSUPwhale, ethers.toBigInt("10000000000000000000"));

        for(var i in users) {
            await RSUP.connect(signers.RSUPwhale).transfer(users[i], 100000n*10n**18n);
            await impersonateAccount(users[i]);
            signers.users[i] = await ethers.getSigner(users[i]);
            await setBalance(users[i], ethers.toBigInt("10000000000000000000"));
        }
        await RSUP.connect(signers.RSUPwhale).transfer(users[8], 1000000n*10n**18n);
        await RSUP.connect(signers.RSUPwhale).transfer(operator, 1000000n*10n**18n);
        await RSUP.connect(signers.RSUPwhale).transfer(depl, 100000n*10n**18n);
        await impersonateAccount(depl);
        signers.depl = await ethers.getSigner(depl);
        await setBalance(depl, ethers.toBigInt("10000000000000000000"));
        await setBalance(keyless, ethers.toBigInt("10000000000000000000"));

        await impersonateAccount(core);
        signers.core = await ethers.getSigner(core);
        await setBalance(core, ethers.toBigInt("10000000000000000000"));

    });

    // hello world tests to verify deployments succeeded
    describe("Validate Deployment Values", () => {
        it("MagicPounder address check", async () => {
            expect(await MagicPounder.operator()).to.be.equal(operator);
            expect(await MagicPounder.manager()).to.be.equal(manager);
        });
        it("MagicVoter address check", async () => {
            expect(await MagicVoter.operator()).to.be.equal(operator);
            expect(await MagicVoter.manager()).to.be.equal(manager);
        });
        it("MagicStaker address check", async () => {
            expect(await MagicStaker.operator()).to.be.equal(operator);
            expect(await MagicStaker.manager()).to.be.equal(manager);
            expect(await MagicStaker.strategies(0)).to.be.equal(MagicPounderAddress);
            expect(await MagicStaker.magicVoter()).to.be.equal(MagicVoterAddress);
        });
        it("MagicSavings address check", async () => {
            expect(await MagicSavings.magicStaker()).to.be.equal(MagicStakerAddress);
        });
    });

    // Configuration of contracts
    describe("Initial Setup - Harvester", () => {
        // Add harvester routes
        describe("Add reUSD->RSUP harvesting route", () => {
            it("Approve reUSD for MagicHarvester", async () => {
                await reUSD.connect(signers.operator).approve(MagicHarvesterAddress, 1000000n*10n**18n);
                expect(await reUSD.allowance(signers.operator.address, MagicHarvesterAddress)).to.be.equal(1000000n*10n**18n);
            });
            it("Set reUSD->RSUP route in MagicHarvester", async () => {
                let route = [
                    { 
                        pool: "0xc522A6606BBA746d7960404F22a3DB936B6F4F50", 
                        tokenIn: reUSDAddress, 
                        tokenOut: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", 
                        functionType: 0, 
                        indexIn: 0, 
                        indexOut: 1 
                    }, // curve reUSD->scrvUSD
                    { 
                        pool: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", 
                        tokenIn: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", 
                        tokenOut: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", 
                        functionType: 1, 
                        indexIn: 1, 
                        indexOut: 0 
                    }, // scrvUSD redeem
                    { 
                        pool: "0x4eBdF703948ddCEA3B11f675B4D1Fba9d2414A14", 
                        tokenIn: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", 
                        tokenOut: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 
                        functionType: 2, 
                        indexIn: 0, 
                        indexOut: 1 
                    }, // curve exchange
                    { 
                        pool: "0xEe351f12EAE8C2B8B9d1B9BFd3c5dd565234578d", 
                        tokenIn: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 
                        tokenOut: RSUPAddress, 
                        functionType: 4, 
                        indexIn: 0, 
                        indexOut: 1 
                    } // curve exchange
                ];

                var RSUPbalBefore = await RSUP.balanceOf(operator);
                await MagicHarvester.connect(signers.operator).setRoute(reUSDAddress, route, RSUPAddress, 10n*10n**18n, false);
                // expect RSUP balance increase for operator after route set (due to initial harvest)
                var RSUPbalAfter = await RSUP.balanceOf(operator);
                expect(RSUPbalAfter).to.be.gt(RSUPbalBefore);
            });
        });
        describe("Add reUSD->sreUSD harvesting route", () => {
            it("Set reUSD->sreUSD route in MagicHarvester", async () => {
                let route = [
                    { 
                        pool: sreUSDAddress, 
                        tokenIn: reUSDAddress, 
                        tokenOut: sreUSDAddress, 
                        functionType: 3, 
                        indexIn: 0, 
                        indexOut: 1 
                    }
                ];

                var sreUSDBalBefore = await sreUSD.balanceOf(operator);
                await MagicHarvester.connect(signers.operator).setRoute(reUSDAddress, route, sreUSDAddress, 10n*10n**18n, false);
                // expect RSUP balance increase for operator after route set (due to initial harvest)
                var sreUSDBalAfter = await sreUSD.balanceOf(operator);
                expect(sreUSDBalAfter).to.be.gt(sreUSDBalBefore);
            });
        });
    });
    describe("Initial Setup", () => {

        // Connecting staker and components
        it("Set MagicStaker in MagicPounder", async () => {
            await MagicPounder.connect(signers.operator).setMagicStaker(MagicStakerAddress);
            expect(await MagicPounder.magicStaker()).to.be.equal(MagicStakerAddress);
        });
        it("Set MagicStaker in MagicVoter", async () => {
            await MagicVoter.connect(signers.operator).setMagicStaker(MagicStakerAddress);
            expect(await MagicVoter.magicStaker()).to.be.equal(MagicStakerAddress);
        });
        it("Add MagicSavings strategy", async () => {
            expect(await MagicStaker.connect(signers.operator).addStrategy(MagicSavingsAddress)).to.be.not.reverted;
        });

        // Adding harvester
        it("Set MagicHarvester as Strategy 0 and Strategy 1 Harvester in MagicStaker", async () => {
            await MagicStaker.connect(signers.operator).setStrategyHarvester(MagicPounderAddress, MagicHarvesterAddress, true);
            expect(await MagicStaker.strategyHarvester(MagicPounderAddress)).to.be.equal(MagicHarvesterAddress);
            await MagicStaker.connect(signers.operator).setStrategyHarvester(MagicSavingsAddress, MagicHarvesterAddress, true);
            expect(await MagicStaker.strategyHarvester(MagicSavingsAddress)).to.be.equal(MagicHarvesterAddress);
        });

        it("Set magicStaker as rewardCaller on Harvester", async () => {
            expect(await MagicHarvester.connect(signers.operator).addRewardCaller(MagicStakerAddress)).to.be.not.reverted;
        });

        it("Approves desiredTokens for strategies", async () => {
            await MagicHarvester.connect(signers.operator).approveStrategy(MagicPounderAddress, true);
            await MagicHarvester.connect(signers.operator).approveStrategy(MagicSavingsAddress, true);
        });

    });

    // Have test accounts create deposits
    describe("Users 0-7, 8 deposits", () => {
        
        // Set weights
        it("Should have users set weights", async () => {
            expect(await MagicStaker.connect(signers.users[0]).setWeights([2500, 7500])).to.be.not.reverted;
            for(var i=1; i<8; i++) {
                var strat0w = 5000;
                var strat1w = 10000 - strat0w;
                expect(await MagicStaker.connect(signers.users[i]).setWeights([strat0w, strat1w])).to.be.not.reverted;
            }
            expect(await MagicStaker.connect(signers.users[8]).setWeights([6000, 4000])).to.be.not.reverted;
            expect(await MagicStaker.connect(signers.operator).setWeights([6000, 4000])).to.be.not.reverted;
            expect(await MagicStaker.connect(signers.depl).setWeights([8000, 2000])).to.be.not.reverted;
        });

        // Token approval
        it("Should have users give token approval", async () => {
            for(var i=0; i<9; i++) {
                expect(await RSUP.connect(signers.users[i]).approve(MagicStakerAddress, 1000000000n*10n**18n)).to.be.not.reverted;
            }
            expect(await RSUP.connect(signers.operator).approve(MagicStakerAddress, 1000000000n*10n**18n)).to.be.not.reverted;
            expect(await RSUP.connect(signers.depl).approve(MagicStakerAddress, 1000000000n*10n**18n)).to.be.not.reverted;
        });

        // Deposit
        it("Should have users stake/deposit", async () => {
            for(var i=0; i<8; i++) {
                expect(await MagicStaker.connect(signers.users[i]).stake(100000n*10n**18n)).to.be.not.reverted;
            }
            expect(await MagicStaker.connect(signers.users[8]).stake(1000000n*10n**18n)).to.be.not.reverted;
            expect(await MagicStaker.connect(signers.operator).stake(100000n*10n**18n)).to.be.not.reverted;
            expect(await MagicStaker.connect(signers.depl).stake(10000n*10n**18n)).to.be.not.reverted;
            var accountData = await MagicStaker.accountStakeData(users[3]);
            //console.log("User 3 stake data:", accountData);
        });

        // Verify weights cannot be changed in same epoch
        it("Should not allow users to change weights in same epoch", async () => {
            for(var i=0; i<9; i++) {
                var strat0w = Math.floor(Math.random()*10000);
                var strat1w = 10000 - strat0w;
                await expect(MagicStaker.connect(signers.users[i]).setWeights([strat0w, strat1w])).to.be.revertedWith("!epoch");
            }
        });
        it("Total of strategy supplies should equal total staker supply", async () => {
            var strat0sup = await MagicPounder.totalSupply();
            var strat1sup = await MagicSavings.totalSupply();
            var totalSup = await MagicStaker.totalSupply();
            await expect(strat0sup + strat1sup).to.be.equal(totalSup);
        });
    });

    // Cooldown and harvest/claim tests
    describe("Test cooldowns and claims", () => {

        // Advance time to next cooldown epoch. Skip current if already there.
        it("Should advance time until next cooldown epoch is reached", async () => {
            var isCooldown = false;
            var c = 0;
            while(!isCooldown) {
                await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
                await ethers.provider.send("evm_mine", []);
                isCooldown = await MagicStaker.isCooldownEpoch();
                c++;
            }
            console.log("     > advanced "+c+" weeks to reach cooldown epoch");
            var accountData = await MagicStaker.accountStakeData(users[3]);
            //console.log("User 3 stake data:", accountData);
            await MagicStaker.connect(signers.users[3]).checkpointAccount(users[3]);
            accountData = await MagicStaker.accountStakeData(users[3]);
            //console.log("User 3 stake data:", accountData);
        });

        // Have some users enter cooldown before reward harvest
        it("Should have users 3 and 4 enter cooldown", async () => {
            var strat0sup = await MagicPounder.totalSupply();
            var strat1sup = await MagicSavings.totalSupply();
            var totalSup = await MagicStaker.totalSupply();
            //console.log(`     > Pre-cooldown supplies:   Staker: ${(totalSup/10n**18n)}   Pounder: ${(strat0sup/10n**18n)}   Savings: ${(strat1sup/10n**18n)}`);
            for(var i=3; i<5; i++) {
                var balBefore = await MagicStaker.balanceOf(users[i]);
                //console.log(`     > User ${i} stake before cooldown: ${(balBefore/10n**18n)}`);
                await expect(MagicStaker.connect(signers.users[i]).cooldown(100000n*10n**18n)).to.be.not.reverted;
            }
        });
        it("Total of strategy supplies should equal total staker supply", async () => {
            var strat0sup = await MagicPounder.totalSupply();
            var strat1sup = await MagicSavings.totalSupply();
            var totalSup = await MagicStaker.totalSupply();
            //console.log(`     > Post-cooldown supplies:  Staker: ${(totalSup/10n**18n)}   Pounder: ${(strat0sup/10n**18n)}   Savings: ${(strat1sup/10n**18n)}`);
            var balAfter = await MagicStaker.balanceOf(users[3]);
            //console.log(`     > User 3 stake after cooldown: ${(balAfter/10n**18n)}`);
            balAfter = await MagicStaker.balanceOf(users[4]);
            //console.log(`     > User 4 stake after cooldown: ${(balAfter/10n**18n)}`);
            await expect(strat0sup + strat1sup).to.be.equal(totalSup);
        });
        // Harvest rewards
        it("Should harvest rewards", async () => {
            var earned = await staker.earned(MagicStakerAddress, reUSDAddress);
            //console.log(`Claiming ${(earned/10n**18n)} reUSD from staker`);

            var opBalBefore = await reUSD.balanceOf(operator);
            var mPuSBefore = await MagicPounder.totalSupply();
            var mPtSBefore = await MagicPounder.sharesTotalSupply();

            expect(await MagicStaker.connect(signers.operator).harvest()).to.be.not.reverted;

            var mPuSAfter = await MagicPounder.totalSupply();
            var mPtSAfter = await MagicPounder.sharesTotalSupply();
            var opBalAfter = await reUSD.balanceOf(operator);

            // Should increase compounder underlyingTotalSupply
                await expect(mPuSBefore).to.be.lt(mPuSAfter);
            // Should not change the share supply of compounder
                await expect(mPtSBefore).to.be.equal(mPtSAfter);
            // Should increase harvest caller's reUSD balance
                await expect(opBalBefore).to.be.lt(opBalAfter);
        });

        // Verify remaining users received have pending claims
        describe("Should validate claim amounts", async () => {
            var umt = []; var w = []; var ust = []; var sw = [];
            before(async function () {
                // Prefetch values
                for(var i=0; i<9; i++) {
                    umt[i] = await MagicStaker.unclaimedMagicTokens(users[i]);
                    w[i] = await MagicStaker.accountStrategyWeight(users[i], 0);
                    ust[i] = await MagicSavings.claimable(users[i]);
                    sw[i] = await MagicStaker.accountStrategyWeight(users[i], 1);
                }
                //console.log(umt);
                //console.log(w);
                //console.log(ust);
                //console.log(sw);
            });

            // Validate amounts
            it("User 0 has half as much RSUP to claim", async () => {
                await expect(umt[0]).to.be.approximately(umt[1]/2n, 1n);
            });
            it("User 0 has 50% more reUSD to claim", async () => {
                await expect(ust[0]).to.be.approximately(ust[1]*15n/10n, 1n);
            });
            it("Users 1 and 2 have identical claims", async () => {
                await expect(umt[1]).to.be.equal(umt[2]);
                await expect(ust[1]).to.be.equal(ust[2]);
            });
            it("Cooldown users (3,4) have nothing to claim", async () => {
                await expect(umt[3]).to.be.equal(0);
                await expect(umt[4]).to.be.equal(0);
            });
            it("Total of strategy supplies should equal total staker supply", async () => {
                var strat0sup = await MagicPounder.totalSupply();
                var strat1sup = await MagicSavings.totalSupply();
                var totalSup = await MagicStaker.totalSupply();
                await expect(strat0sup + strat1sup).to.be.equal(totalSup);
            });
        });
    });
    describe("Post-harvest tests", () => {
        // Verify compounding claim can be instantly entered into cooldown, but nothing more
        describe("Claim + cooldown in same step", async () => {
            let umt;
            before(async function () {
                umt = await MagicStaker.unclaimedMagicTokens(users[0]);
            });
            it("Should allow user 0 to cooldown only realized stake, not new claim", async () => {
                await expect(MagicStaker.connect(signers.users[0]).cooldown(100000n*10n**18n + umt)).to.be.revertedWithCustomError(MagicStaker, "InsufficientRealizedStake");
                await expect(MagicStaker.connect(signers.users[0]).cooldown(100000n*10n**18n + 1n)).to.be.revertedWithCustomError(MagicStaker, "InsufficientRealizedStake");
                await expect(MagicStaker.connect(signers.users[0]).cooldown(100000n*10n**18n)).to.be.not.reverted;
            });
            it("User 0 should now have zero unclaimed RSUP", async () => {
                await expect(await MagicStaker.unclaimedMagicTokens(users[0])).to.be.equal(0);
            });
            it("User 0 should have reduced stake by cooldown amount", async () => {
                var stake = await MagicStaker.balanceOf(users[0]);
                await expect(stake).to.be.equal(umt);
            });
            it("User 0 strategy balances should match original unclaimed amount", async () => {
                var strat0bal = await MagicPounder.balanceOf(users[0]);
                var strat1bal = await MagicSavings.balanceOf(users[0]);
                await expect(strat0bal+strat1bal).to.be.approximately(umt, 1n);
            });
            it("User 0 should not be able to cooldown again", async () => {
                await expect(MagicStaker.connect(signers.users[0]).cooldown(1n)).to.be.revertedWithCustomError(MagicStaker, "InsufficientRealizedStake");
            });
            it("User 0 should still have sreUSD to claim", async () => {
                var claimable = await MagicSavings.claimable(users[0]);
                await expect(claimable).to.be.gt(0);
            });
            it("User 0 should claim sreUSD", async () => {
                var sreUSDbefore = await sreUSD.balanceOf(users[0]);
                expect(await MagicSavings.connect(signers.users[0]).claim()).to.be.not.reverted;
                var sreUSAfter = await sreUSD.balanceOf(users[0]);
                await expect(sreUSAfter).to.be.gt(sreUSDbefore);
            });
            it("User 0 should have 0 claimable sreUSD", async () => {
                var claimable = await MagicSavings.claimable(users[0]);
                await expect(claimable).to.be.equal(0);
            });
            it("Total of strategy supplies should equal total staker supply", async () => {
                var strat0sup = await MagicPounder.totalSupply();
                var strat1sup = await MagicSavings.totalSupply();
                var totalSup = await MagicStaker.totalSupply();
                var diff = strat0sup + strat1sup - totalSup;
                //console.log("Difference in supplies: "+diff);
                await expect(strat0sup + strat1sup).to.be.equal(totalSup);
            });
        });
        describe("User 1 claims", () => {
            let startTotalSupply, umt, startBal, s0sup, s1sup, s0bal, s1bal;
            before(async function () {
                startTotalSupply = await MagicStaker.totalSupply();
                umt = await MagicStaker.unclaimedMagicTokens(users[1]);
                startBal = await MagicStaker.balanceOf(users[1]);
                s0sup = await MagicPounder.totalSupply();
                s1sup = await MagicSavings.totalSupply();
                s0bal = await MagicPounder.balanceOf(users[1]);
                s1bal = await MagicSavings.balanceOf(users[1]);
            });
            it("User 1 should claim RSUP", async () => {
                expect(await MagicStaker.connect(signers.users[1]).syncAccount()).to.be.not.reverted;
            });
            it("User 1 should have no unclaimed magic tokens", async () => {
                var umt = await MagicStaker.unclaimedMagicTokens(users[1]);
                await expect(umt).to.be.equal(0);
            });
            it("User 1 should have an increased stake", async () => {
                var stake = await MagicStaker.balanceOf(users[1]);
                await expect(startBal+umt).to.be.equal(stake);
            });
            it("User 1 should claim sreUSD", async () => {
                var sreUSDbefore = await sreUSD.balanceOf(users[1]);
                expect(await MagicSavings.connect(signers.users[1]).claim()).to.be.not.reverted;
                var sreUSAfter = await sreUSD.balanceOf(users[1]);
                await expect(sreUSAfter).to.be.gt(sreUSDbefore);
            });
            it("User 1 should have 0 claimable sreUSD", async () => {
                var claimable = await MagicSavings.claimable(users[1]);
                await expect(claimable).to.be.equal(0);
            });
            it("Total supply should not change", async () => {
                var totalSup = await MagicStaker.totalSupply();
                await expect(startTotalSupply).to.be.equal(totalSup);
            });
            it("Total of strategy supplies should equal total staker supply", async () => {
                var strat0sup = await MagicPounder.totalSupply();
                var strat1sup = await MagicSavings.totalSupply();
                var afterBal = await MagicStaker.balanceOf(users[1]);
                var as0bal = await MagicPounder.balanceOf(users[1]);
                var as1bal = await MagicSavings.balanceOf(users[1]);
                //console.log("User 1 stake before: "+startBal);
                //console.log(" User 1 stake after: "+afterBal);
                //console.log("User 1 s0 bal before: "+s0bal);
                //console.log(" User 1 s0 bal after: "+as0bal);
                //console.log("User 1 s1 bal before: "+s1bal);
                //console.log(" User 1 s1 bal after: "+as1bal);
                //console.log("Starting s0 supply: "+s0sup);
                //console.log("  Ending s0 supply: "+strat0sup);
                //console.log("Starting s1 supply: "+s1sup);
                //console.log("  Ending s1 supply: "+strat1sup);
                var totalSup = await MagicStaker.totalSupply();
                await expect(strat0sup + strat1sup).to.be.equal(totalSup);
            });
        });
        describe("User 2 changes weights", () => {
            let umt, msb, w, wb, wbs, ust, sw;
            before(async function () {
                umt = await MagicStaker.unclaimedMagicTokens(users[2]);
                msb = await MagicStaker.balanceOf(users[2]);
                w = await MagicStaker.accountStrategyWeight(users[2], 0);
                wb = await MagicPounder.balanceOf(users[2]);
                wbs = await MagicPounder.sharesOf(users[2]);
                ust = await MagicSavings.claimable(users[2]);
                sw = await MagicStaker.accountStrategyWeight(users[2], 1);
            });
            it("User 2 should be able to change weights", async () => {
                expect(await MagicStaker.connect(signers.users[2]).setWeights([1000, 9000])).to.be.not.reverted;
            });
            it("Unclaimed magic tokens should drop to 0", async () => {
                var umtn = await MagicStaker.unclaimedMagicTokens(users[2]);
                await expect(umtn).to.be.equal(0);
            });
            it("Staker balance should increase by original unclaimed magic tokens", async () => {
                var msbn = await MagicStaker.balanceOf(users[2]);
                await expect(msbn).to.be.approximately(msb+umt,1);
            });
            it("New pounder balance should be 10% of the staker balance", async () => {
                var wbn = await MagicPounder.balanceOf(users[2]);
                var msbn = await MagicStaker.balanceOf(users[2]);
                await expect(wbn).to.be.approximately(msbn*10n/100n,1);
            });
            it("Total of strategy supplies should equal total staker supply", async () => {
                var strat0sup = await MagicPounder.totalSupply();
                var strat1sup = await MagicSavings.totalSupply();
                var totalSup = await MagicStaker.totalSupply();
                await expect(strat0sup + strat1sup).to.be.equal(totalSup);
            });
        });
    });
    describe("Voting", () => {
        let proposalCountBefore;
        before(async function () {
            proposalCountBefore = await voter.getProposalCount();
        });
        it("Should advance time 2 weeks", async () => {
                await ethers.provider.send("evm_increaseTime", [14 * 24 * 60 * 60]);
                await ethers.provider.send("evm_mine", []);
        });
        it("User 8 should be able to propose vote", async () => {
            // createProposal(Voter.Action[] calldata payload, string calldata description)
            expect(await MagicStaker.connect(signers.users[8]).createProposal([{target:MagicStakerAddress, data:"0x43676852"}], "test")).to.be.not.reverted;
        });
        it("RSUP Proposal count should increase by 1", async () => {
            let proposalCountAfter = await voter.getProposalCount();
            await expect(proposalCountAfter).to.be.equal(proposalCountBefore+1n);
        });
        describe("Casting meta-votes", () => {
            it("User 1-2 can vote yes", async () => {
                expect(await MagicVoter.connect(signers.users[1]).vote(proposalCountBefore, 10000n, 0n)).to.be.not.reverted;
                expect(await MagicVoter.connect(signers.users[2]).vote(proposalCountBefore, 10000n, 0n)).to.be.not.reverted;
            });
            it("'Yes' total increases by getVotingPower() of users 1-2", async () => {
                var user1power = await MagicStaker.getVotingPower(users[1]);
                var user2power = await MagicStaker.getVotingPower(users[2]);
                var voteTotals = await MagicVoter.voteTotals(voterAddress, proposalCountBefore);
                await expect(voteTotals[0]).to.be.equal(user1power + user2power);
            });
            it("User 3-4 cannnot vote", async () => {
                await expect(MagicVoter.connect(signers.users[3]).vote(proposalCountBefore, 10000n, 0n)).to.be.revertedWith("No voting power");
                await expect(MagicVoter.connect(signers.users[4]).vote(proposalCountBefore, 10000n, 0n)).to.be.revertedWith("No voting power");
            });
            it("Should advance time 5 days", async () => {
                await ethers.provider.send("evm_increaseTime", [5 * 24 * 60 * 60]);
                await ethers.provider.send("evm_mine", []);
            });
            it("User 5 can vote no", async () => {
                expect(await MagicVoter.connect(signers.users[5]).vote(proposalCountBefore, 0n, 10000n)).to.be.not.reverted;
                //expect(await MagicVoter.connect(signers.users[6]).vote(proposalCountBefore, 0n, 10000n)).to.be.not.reverted;
            });
            it("'No' total increases by 5 voting power", async () => {
                var user5power = await MagicStaker.getVotingPower(users[5]);
                //var user6power = await MagicStaker.getVotingPower(users[6]);
                var voteTotals = await MagicVoter.voteTotals(voterAddress, proposalCountBefore);
                await expect(voteTotals[1]).to.be.equal(user5power);
                //console.log(voteTotals);
            });
            it("Should not allow non-local-quorum vote", async () => {
                await expect(MagicVoter.connect(signers.operator).commitVote(proposalCountBefore)).to.be.revertedWith("!quorum");
                var createdEpoch = await MagicVoter.timeToEpoch((await voter.getProposalData(proposalCountBefore)).createdAt);
                console.log("> Created epoch: "+createdEpoch);
                await MagicStaker.connect(signers.users[1]).checkpointTotal(); // totalPowerAt needs checkpointed for accurate quorum calculation
                var totalPowerAt = await MagicStaker.totalPowerAt(createdEpoch);
                var voteTotals = await MagicVoter.voteTotals(voterAddress, proposalCountBefore);
                var totalVoted = voteTotals[0] + voteTotals[1];
                console.log("           Pct voted:    "+totalVoted*100n/totalPowerAt)
            });
            it("Should cast vote automatically when User 6 votes Yes", async () => {
                var voteBefore = await voter.accountVoteWeights(MagicStakerAddress, proposalCountBefore);
                expect(await MagicVoter.connect(signers.users[6]).vote(proposalCountBefore, 10000n, 0n)).to.emit("VoteCast")
                var voteAfter = await voter.accountVoteWeights(MagicStakerAddress, proposalCountBefore);
            });
            
        });
    });
    describe("Migration", () => {
        let newStaker;
        let newStakerAddress;
        // core sets cooldown epochs to 0
        it("User 0 unstakes", async () => {
            await MagicStaker.connect(signers.users[0]).unstake();
        });

        it("Core sets cooldown epochs to 0", async () => {
            await staker.connect(signers.core).setCooldownEpochs(0);
            var cooldownEpochs = await staker.cooldownEpochs();
            await expect(cooldownEpochs).to.be.equal(0);
        });

        // core deploys new staker
        it("Core deploys new staker", async () => {
            let salt = ethers.keccak256(ethers.toUtf8Bytes("MAGIC_STAKER_V2")); // can by anythinglet constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "uint24"], [core, registryAddress, RSUPAddress, 2]);
            let initCode = "0x61014080604052346102ae576080816138be803803809161002082856102ed565b8339810103126102ae5761003381610310565b61003f60208301610310565b90606061004e60408501610310565b9301519062ffffff82168092036102ae5760015f556001600160a01b031660808190526040516378e9792560e01b8152602081600481855afa908115610265575f916102ba575b5060a052604051630afaeebf60e31b815290602090829060049082905afa908115610265575f91610284575b5060c052604051610227808201906001600160401b0382118383101761027057604091839161369783393081526001600160a01b03871660208201520301905ff0918215610265577fc7a3b172868cdcc74bbcf808a3d5a3e88aa94454cae07ab3c27fe138d3210d29936020936101005260e05281600b5560018060a01b031661012052604051908152a1604051613372908161032582396080518181816103ac015281816108e3015281816109b5015281816113780152818161184801528181611af1015281816125e3015261265b015260a051818181610526015281816111010152818161122601528181611453015281816115080152818161192501528181611c0e01528181611c6e01528181611d2a0152818161202701528181612186015281816123a50152613092015260c05181818161054d0152818161091a015281816116f80152612b81015260e051818181610a460152818161173101528181611e1f0152818161257a01528181612c7501526131ac01526101005181818161081c01528181612c510152612dc301526101205181818161140c0152611cd80152f35b6040513d5f823e3d90fd5b634e487b7160e01b5f52604160045260245ffd5b90506020813d6020116102b2575b8161029f602093836102ed565b810103126102ae57515f6100c1565b5f80fd5b3d9150610292565b90506020813d6020116102e5575b816102d5602093836102ed565b810103126102ae57516004610095565b3d91506102c8565b601f909101601f19168101906001600160401b0382119082101761027057604052565b51906001600160a01b03821682036102ae5756fe6080806040526004361015610012575f80fd5b5f905f3560e01c90816301320fe2146120515750806306aba0e11461200a57806307f93a3814611fe35780630aed7b0d14611cab57806312cf9dad14611c385780631491496f14611bf057806318160ddd14611bd25780631930e82514611b7a5780631e9049cf14611b5c578063211dc32d14611b2f5780632378bea614611a2b5780633d18b912146119505780633ea01b34146118fe5780633f695b451461181f5780633f90916a146117f857806348e5d9f81461177f57806350735f6f1461176057806351ed6a301461171b57806357d775f8146116e0578063638634ee146116bc5780636889d9ae146115c45780636ca541e5146115a45780637035ab981461155157806370a082311461152d578063757991a8146114ed57806375a410141461147657806378e979251461143b5780637b103999146113f65780637bb7bed1146113b25780638980f11f146113555780638da5cb5b146103965780639d716bc6146113315780639e94080e146111f3578063a694fc3a146111d3578063aaf5eb68146111b0578063adc9772e14611188578063b42652e9146110ab578063b66503cf14610ddf578063bcd1101414610d92578063bf199e6214610d74578063c00007b014610c7e578063c3c854b614610bef578063c950ba7f14610bd1578063d0ed26ae14610989578063d6e5085f146108bb578063deb906e71461084b578063e2fdcc1714610806578063e509b9d9146107c5578063e70b9e2714610772578063e7805809146105bc578063e7a6bc44146104dc578063eb8f4f70146104be578063ebae46701461047c578063f122977714610458578063f21f3c08146103db578063f2f4eb2614610396578063fbeb4336146103715763ff342e091461029c575f80fd5b3461036e57602036600319011261036e576102b5612097565b6102bd612505565b9081516102c981612809565b916102d7604051938461213b565b8183526102e382612809565b602084019490601f1901368637855b83811061033d57868587604051928392602084019060208552518091526040840192915b818110610324575050500390f35b8251845285945060209384019390920191600101610316565b60019061035d6001600160a01b036103558386612558565b5116856122ea565b6103678288612558565b52016102f2565b80fd5b503461036e578060031936011261036e57602061ffff60095460701c16604051908152f35b503461036e578060031936011261036e576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b503461036e57604036600319011261036e5761042a6020916103fb612097565b6104036120ad565b916001600160a01b03821633811491908215610432575b505061042590612441565b612d7a565b604051908152f35b815260068652604090819020335f9081529087529081205460ff1691506104259061041a565b503461036e57602036600319011261036e57602061042a610477612097565b612758565b503461036e57602036600319011261036e5760209060ff906040906001600160a01b036104a7612097565b16815260078452205460f01c166040519015158152f35b503461036e578060031936011261036e576020600b54604051908152f35b503461036e57604036600319011261036e5761042a6020916104fc612097565b906001600160a01b03821633811491908215610596575b505061051e90612441565b61057261054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b7f0000000000000000000000000000000000000000000000000000000000000000906122cc565b9061057d8282612821565b509061058d606083015115612715565b60243590612a03565b815260068552604090819020335f9081529086529081205460ff16915061051e90610513565b503461036e57604036600319011261036e576105d6612097565b6105de6120ad565b6105e6613010565b6001546001600160a01b03831690811515855b8281106106c95750505080845260036020526040842060018060a01b0383165f5260205260405f20549283610631575b846001815580f35b8185526003602090815260408087206001600160a01b038681165f9081529184529082902088905584885260058352908720547fce405e67b4d6e56e438257e15f160ae28b450e6e7659bbc4c1f4e09a1ac846cb9391169081156106c15750935b6001600160a01b0316936106a786828761302e565b6040519586526001600160a01b031694a45f808080610629565b905093610692565b806106d56001926120c3565b838060a01b0391549060031b1c166106ec81612758565b90808a52600260205281600560408c200155846107088261241c565b828c526002602052600460408d200155610725575b5050016105f9565b61072f818a6122ea565b878b52600360205260408b20858060a01b0383165f5260205260405f2055868a52600460205260408a2090848060a01b03165f5260205260405f20555f8061071d565b503461036e57604036600319011261036e57604061078e612097565b916107976120ad565b9260018060a01b031681526003602052209060018060a01b03165f52602052602060405f2054604051908152f35b503461036e57602036600319011261036e576020906001600160a01b036107ea612097565b16815260058252604060018060a01b0391205416604051908152f35b503461036e578060031936011261036e576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b503461036e57602036600319011261036e576080906040906001600160a01b03610873612097565b1681526007602052205460ff604051916001600160701b03811683526001600160701b038160701c16602084015261ffff8160e01c16604084015260f01c1615156060820152f35b503461036e57602036600319011261036e5760043562ffffff811680910361098557610911337f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031614612369565b6276a70061093f7f0000000000000000000000000000000000000000000000000000000000000000836122b9565b11610976576020817fc7a3b172868cdcc74bbcf808a3d5a3e88aa94454cae07ab3c27fe138d3210d2992600b55604051908152a180f35b637616640160e01b8252600482fd5b5080fd5b503461036e57606036600319011261036e576109a3612097565b6109ab6120ad565b604435916109e3337f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031614612369565b6001600160a01b03169081158015610bc0575b610bb1578215610ba25781845260026020526001604085200154610b935760405163313ce56760e01b8152602081600481865afa908115610b88578591610b47575b5060ff6012911603610b38577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168214610b295760015468010000000000000000811015610b15577f8ab68562a70a02d12b0bbb803d106d670bb6660d060e8cc535baee4fcb04598b91610abc826001602094016001556120c3565b81546001600160a01b0360039290921b82811b199091169087901b179091558487526002808452604080892080546001600160a01b0319169490931693841790925585885283528087206001018690555194855293a380f35b634e487b7160e01b85526041600452602485fd5b633f7bbeb960e21b8452600484fd5b63568fc68760e11b8452600484fd5b90506020813d602011610b80575b81610b626020938361213b565b81010312610b7c575160ff81168103610b7c5760ff610a38565b8480fd5b3d9150610b55565b6040513d87823e3d90fd5b6311ae984360e21b8452600484fd5b633019509960e21b8452600484fd5b63d92e233d60e01b8452600484fd5b506001600160a01b038116156109f6565b503461036e57602036600319011261036e57610beb612097565b5080f35b503461036e57604036600319011261036e57610c09612097565b60243590811515809203610c7a5733835260066020526040832060018060a01b0382165f5260205260405f2060ff1981541660ff841617905560405191825260018060a01b0316907f92d241afb0a1a9b3441bf1bd6bea0f9164cf5a2562cbe4bcc34ab943b246560860203392a380f35b8280fd5b503461036e57602036600319011261036e57610c98612097565b610ca0613010565b6001546001600160a01b03821680151590845b838110610ccb5785610cc486612e8f565b6001815580f35b80610cd76001926120c3565b838060a01b0391549060031b1c16610cee81612758565b90808952600260205281600560408b20015585610d0a8261241c565b828b526002602052600460408c200155610d27575b505001610cb3565b610d3181896122ea565b858a52600360205260408a20858060a01b0383165f5260205260405f205584895260046020526040892090848060a01b03165f5260205260405f20555f80610d1f565b503461036e578060031936011261036e576020600154604051908152f35b503461036e57602036600319011261036e5760209061042a90600160406001600160a01b03610dbf612097565b1692838152600286526003828220015493815260028652200154906122b9565b503461036e57604036600319011261036e57610df9612097565b60243590600154835b8181106110595750506001600160a01b03168083526002602052604080842090519192919060c0820167ffffffffffffffff8111838210176110455760405260018060a01b03815416908183526001810154602084019081526002820154604085019081526003830154916060860192835260056004850154946080880195865201549460a08701958652330361103757861561102857600d541561101957610ead8730338b6132c9565b8151428111610fea5750610ec28151886122cc565b6040516370a0823160e01b81523060048201526020816024818d5afa8015610fdf578b90610fa7575b610ef891508351906122cc565b8111610f9857927fac24935fd910bc682b5ccb1a07b718cadf8cf2f6d1404c4f3ddc3662dae40e2997959260209795926005958352428452610f3b81514261215d565b82528a8c526002895260408c209660018060a01b039060018060a01b03905116166bffffffffffffffffffffffff60a01b88541617875551600187015551600286015551600385015551600484015551910155604051908152a280f35b63474c247160e01b8a5260048afd5b506020813d602011610fd7575b81610fc16020938361213b565b81010312610fd357610ef89051610eeb565b5f80fd5b3d9150610fb4565b6040513d8d823e3d90fd5b61100c611006610ffe6110149342906122ac565b8651906122b9565b8961215d565b8251906122cc565b610ec2565b6347fc732760e11b8952600489fd5b633019509960e21b8952600489fd5b6282b42960e81b8952600489fd5b634e487b7160e01b86526041600452602486fd5b806110656001926120c3565b838060a01b0391549060031b1c1661107c81612758565b818852600260205260056040892001556110958161241c565b9087526002602052600460408820015501610e02565b503461036e57602036600319011261036e5760209060016001600160701b036110d2612097565b6110da613010565b828060a01b0381168033148015611161575b6110f69150612441565b61115561112661054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b9161114f6111348483612821565b5093611144606086015115612715565b848681511684612a03565b50612e8f565b51169155604051908152f35b5084526006855260408420838060a01b0333165f5285526110f660ff60405f2054166110ec565b503461036e57604036600319011261036e57602061042a6111a7612097565b6024359061306f565b503461036e578060031936011261036e576020604051670de0b6b3a76400008152f35b503461036e57602036600319011261036e57602061042a6004353361306f565b503461036e57602036600319011261036e5761120d612097565b611215612288565b506112da604061125161124b61054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b84612821565b6001600160a01b0390941685526007602090815291909420845181549286015160408701516001600160f01b03199094166001600160701b03929092169190911760709190911b600160701b600160e01b03161760e09290921b61ffff60e01b169190911781559192916060830151815460ff60f01b191690151560f01b60ff60f01b16179055565b61132d6040519283928360809093929193606060a08201956001600160701b0381511683526001600160701b03602082015116602084015261ffff60408201511660408401520151151560608201520152565b0390f35b503461036e57602036600319011261036e57602061042a611350612097565b6126bd565b503461036e57604036600319011261036e576113af611372612097565b6113a6337f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031614612369565b6024359061256c565b80f35b503461036e57602036600319011261036e576004359060015482101561036e5760206113dd836120c3565b905460405160039290921b1c6001600160a01b03168152f35b503461036e578060031936011261036e576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b503461036e578060031936011261036e5760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b503461036e57602036600319011261036e57611490612097565b611498613010565b3380835260056020526040832080546001600160a01b0319166001600160a01b039390931692831790557ff4239ad0860f93469699dd4be8040b8838c5e25bb6cf24a1dfb381b937ff078c8380a36001815580f35b503461036e578060031936011261036e57602061042a61054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b503461036e57602036600319011261036e57602061042a61154c612097565b6124a2565b503461036e57604036600319011261036e57604061156d612097565b916115766120ad565b9260018060a01b031681526004602052209060018060a01b03165f52602052602060405f2054604051908152f35b503461036e578060031936011261036e576020600b541515604051908152f35b503461036e57602036600319011261036e576001600160a01b036115e6612097565b16803314801561169a575b6115fa90612441565b808252600760205260ff604083205460f01c1661165557808252600760205260408220805460ff60f01b1916600160f01b1790557fd9a2231c15b3bfce8e444b3bcc1a7e724c5368ab52f965679e17bac8abbf101a8280a280f35b60405162461bcd60e51b815260206004820152601c60248201527f616c7265616479207065726d61207374616b6572206163636f756e74000000006044820152606490fd5b50808252600660209081526040808420335f908152925290205460ff166115f1565b503461036e57602036600319011261036e57602061042a6116db612097565b61241c565b503461036e578060031936011261036e5760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b503461036e578060031936011261036e576040517f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03168152602090f35b503461036e57602036600319011261036e57602061042a60043561239d565b503461036e57602036600319011261036e5760c0906040906001600160a01b036117a7612097565b16815260026020522060018060a01b038154169060018101549060028101546003820154906005600484015493015493604051958652602086015260408501526060840152608083015260a0820152f35b503461036e578060031936011261036e5760206001600160701b0360095416604051908152f35b503461036e57604036600319011261036e57611839612097565b6118416120ad565b90611876337f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031614612369565b6001600160a01b031690811580156118ed575b6118de5781835260026020526040832080546001600160a01b0319166001600160a01b03929092169182179055907f8a6fe46a7bcc5ff8e08e5e4d7bf80b812df26f8f800f7a815ccfea20e852b0ec8380a380f35b63d92e233d60e01b8352600483fd5b506001600160a01b03811615611889565b503461036e57602036600319011261036e57602061042a61191d612097565b61194a61054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b9061217e565b503461036e578060031936011261036e57611969613010565b600154331515825b8281106119825783610cc433612e8f565b8061198e6001926120c3565b838060a01b0391549060031b1c166119a581612758565b908087526002602052816005604089200155846119c18261241c565b8289526002602052600460408a2001556119de575b505001611971565b6119e881336122ea565b338852600360205260408820858060a01b0383165f5260205260405f205533875260046020526040872090848060a01b03165f5260205260405f20555f806119d6565b503461036e57604036600319011261036e57611a45612097565b6001600160a01b03168082526002602081905260408320015460243590421115611b2057818352600260205260408320546001600160a01b031633141580611aed575b611adf578015611ad05760207fad2f86b01ed93b4b3a150d448c61a4f5d8d38075d3c0c64cc0a26fd6e1f495459183855260028252806001604087200155604051908152a280f35b633019509960e21b8352600483fd5b6282b42960e81b8352600483fd5b50337f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03161415611a88565b633f1609d560e21b8352600483fd5b503461036e57604036600319011261036e57602061042a611b4e612097565b611b566120ad565b906122ea565b503461036e578060031936011261036e5760206040516276a7008152f35b503461036e57604036600319011261036e576040611b96612097565b91611b9f6120ad565b9260018060a01b031681526006602052209060018060a01b03165f52602052602060ff60405f2054166040519015158152f35b503461036e578060031936011261036e576020600d54604051908152f35b503461036e578060031936011261036e57602061042a611c3361054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b612f7f565b503461036e57604036600319011261036e57611c52612097565b6112da6040611251602435611c65612288565b50611c9361054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b80821015611ca3575b5084612821565b90505f611c9c565b34610fd3575f366003190112610fd3575f600b54611fa857604051635ebaf1db60e01b81526020816004817f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03165afa908115611dc5575f91611f66575b506001600160a01b031690308214611f3657611d4f61054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b611d598133612821565b50606081015115611ef1576001600160701b0381511680611dd0575b505050813b15610fd3575f809260246040518095819363c950ba7f60e01b83523360048401525af1918215611dc557602092611db5575b50604051908152f35b5f611dbf9161213b565b5f611dac565b6040513d5f823e3d90fd5b611ddb935033612a03565b50611de63033612d7a565b611def33612e8f565b60405163095ea7b360e01b81526001600160a01b038316600482015260248101829052602081806044810103815f7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03165af18015611dc557611eba575b506040516356e4bb9760e11b8152336004820152602481018290526020816044815f875af18015611dc557611e8b575b8080611d75565b611eac9060203d602011611eb3575b611ea4818361213b565b810190612279565b5082611e84565b503d611e9a565b6020813d602011611ee9575b81611ed36020938361213b565b81010312610fd357518015158114611e54575f80fd5b3d9150611ec6565b60405162461bcd60e51b815260206004820152601860248201527f6e6f74207065726d61207374616b6572206163636f756e7400000000000000006044820152606490fd5b60405162461bcd60e51b8152602060048201526008602482015267216d69677261746560c01b6044820152606490fd5b90506020813d602011611fa0575b81611f816020938361213b565b81010312610fd357516001600160a01b0381168103610fd35782611d10565b3d9150611f74565b60405162461bcd60e51b81526020600482015260136024820152720636f6f6c646f776e45706f63687320213d203606c1b6044820152606490fd5b34610fd3576040366003190112610fd357602061042a612001612097565b6024359061217e565b34610fd3575f366003190112610fd357602061042a61204c61054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b61239d565b34610fd3576020366003190112610fd3576040906001600160a01b03612075612097565b165f52600c602052815f20546001600160681b038116825260681c6020820152f35b600435906001600160a01b0382168203610fd357565b602435906001600160a01b0382168203610fd357565b6001548110156120db5760015f5260205f2001905f90565b634e487b7160e01b5f52603260045260245ffd5b6080810190811067ffffffffffffffff82111761210b57604052565b634e487b7160e01b5f52604160045260245ffd5b6040810190811067ffffffffffffffff82111761210b57604052565b90601f8019910116810190811067ffffffffffffffff82111761210b57604052565b9190820180921161216a57565b634e487b7160e01b5f52601160045260245ffd5b6121ab61054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b8211612273576001600160a01b03165f818152600760205260409081902090519291906121d7846120ef565b54916001600160701b038316845260208401936001600160701b038460701c168552606060ff61ffff8660e01c169586604085015260f01c1615159101528083101561225657505f52600860205260405f20905f526020526001600160701b0360405f20549151168015612252579061224f9161215d565b90565b5090565b925090505f52600860205260405f20905f5260205260405f205490565b50505f90565b90816020910312610fd3575190565b60405190612295826120ef565b5f6060838281528260208201528260408201520152565b9190820391821161216a57565b8181029291811591840414171561216a57565b81156122d6570490565b634e487b7160e01b5f52601260045260245ffd5b61224f91670de0b6b3a7640000612343612303846124a2565b61233d61230f85612758565b6001600160a01b039687165f8181526004602090815260408083209a8a1683529990529790972054906122ac565b906122b9565b04915f52600360205260405f209060018060a01b03165f5260205260405f20549061215d565b1561237057565b60405162461bcd60e51b815260206004820152600560248201526421636f726560d81b6044820152606490fd5b6123ca61054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b8111612417576009549061ffff8260701c169081811115612405575061224f916001600160701b03915f52600a6020521660405f205461215d565b9150505f52600a60205260405f205490565b505f90565b60018060a01b03165f526002602052600260405f2001548042105f1461224f57504290565b1561244857565b60405162461bcd60e51b81526020600482015260126024820152710850d85b1b195c93dc91195b1959d85d195960721b6044820152606490fd5b906001600160701b03809116911601906001600160701b03821161216a57565b60018060a01b03165f5260076020526001600160701b0361250160405f20604051906124cd826120ef565b5483811691828152606060ff868460701c169384602085015261ffff8160e01c16604085015260f01c161515910152612482565b1690565b60405190600154808352826020810160015f5260205f20925f5b8181106125365750506125349250038361213b565b565b84546001600160a01b031683526001948501948794506020909301920161251f565b80518210156120db5760209160051b010190565b6001600160a01b03908116907f0000000000000000000000000000000000000000000000000000000000000000168114612612576125a8612505565b5f5b81518110156125db57826001600160a01b036125c68385612558565b5116146125d5576001016125aa565b50505050565b5061253492917f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316915061302e565b6040516370a0823160e01b8152306004820152909150602081602481855afa8015611dc5575f90612689575b61264c9150600d54906122ac565b80612655575050565b612534917f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03169061302e565b506020813d6020116126b5575b816126a36020938361213b565b81010312610fd35761264c905161263e565b3d9150612696565b60018060a01b03165f52600c602052602060405f20604051906126df8261211f565b54906001600160681b0382169182825260681c9283910152600b541515908161270b575b506124175790565b905042105f612703565b1561271c57565b60405162461bcd60e51b81526020600482015260146024820152731c195c9b58481cdd185ad95c881858d8dbdd5b9d60621b6044820152606490fd5b600d549081156127ea576127b660018060a01b038216805f5260026020526127a061278a600560405f2001549461241c565b825f526002602052600460405f200154906122ac565b905f526002602052600360405f200154906122b9565b670de0b6b3a7640000810290808204670de0b6b3a7640000149015171561216a5761224f926127e4916122cc565b9061215d565b6001600160a01b03165f90815260026020526040902060050154919050565b67ffffffffffffffff811161210b5760051b60200190565b9061282a612288565b506001600160a01b039091165f818152600760205260408082209051939290612852856120ef565b546001600160701b03811685526001600160701b038160701c16602086015260ff61ffff8260e01c169182604088015260f01c1615156060860152849281958286146129e25750818511156129d3576001600160701b03602085015116916001600160701b038551168315612945575050506128e490825f52600860205260405f20865f5260205260405f205461215d565b935b83811061292557505060600151151561ffff60405192612905846120ef565b6001600160701b03851684525f6020850152166040830152606082015291565b600101815f52600860205260405f20815f526020528460405f20556128e6565b9091979692509492939461298a575b50505f91825260076020526040909120805461ffff60e01b191660e083901b61ffff60e01b1617905561ffff1660408201529190565b909550825f52600860205260405f20905f5260205260405f2054945b8181106129b35780612954565b600101825f52600860205260405f20815f526020528560405f20556129a6565b63252fc9b360e21b5f5260045ffd5b96955050925090505f52600860205260405f20905f5260205260405f205490565b9290926001545f5b818110612cc857505083158015612cb8575b612ca957836001600160701b0384511610612c9a57612a3b82612f7f565b506001600160701b0384166001600160701b0384511603906001600160701b03821161216a576001600160701b0391821684526001600160a01b03165f818152600760209081526040918290208651815492880151938801516001600160f01b031990931695169490941760709290921b600160701b600160e01b03169190911760e09190911b61ffff60e01b1617825592612af291906060905b0151815460ff60f01b191690151560f01b60ff60f01b16179055565b805f52600a60205260405f20612b098482546122ac565b9055815f52600860205260405f20905f5260205260405f20612b2c8382546122ac565b9055612b3a82600d546122ac565b600d55805f52600c60205260405f2060405190612b568261211f565b54906001600160681b0382168152602081019160681c82526001600160681b03612bac612ba6600b547f0000000000000000000000000000000000000000000000000000000000000000906122b9565b4261215d565b1681526001600160981b0384166001600160981b0383511601906001600160981b03821161216a577fa345023a4eda421d4dbe108023f197e12ac173da60a22f9c5a82765eff7f4bf9926001600160981b03604093168152845f52600c6020526001600160681b03835f209251169051916001600160681b03198360681b16821790556001600160981b038351921682526020820152a261224f816001600160a01b037f00000000000000000000000000000000000000000000000000000000000000008116907f00000000000000000000000000000000000000000000000000000000000000001661302e565b63ae9bbc7360e01b5f5260045ffd5b63162908e360e11b5f5260045ffd5b506001600160701b038411612a1d565b80612cd46001926120c3565b838060a01b0391549060031b1c16612ceb81612758565b90805f52600260205281600560405f200155612d068161241c565b815f526002602052600460405f200155838060a01b03861680612d2d575b50505001612a0b565b612d3782886122ea565b815f52600360205260405f20868060a01b0384165f5260205260405f20555f52600460205260405f2090848060a01b03165f5260205260405f20555f8080612d24565b6001600160a01b03165f818152600c6020526040902054606881901c92908315612e87576001600160681b0316421080612e7c575b612e6d575f828152600c60205260408120557f00000000000000000000000000000000000000000000000000000000000000006001600160a01b0316803b15610fd35760405163f3fef3a360e01b81526001600160a01b03929092166004830152602482018490525f908290604490829084905af18015611dc557612e5d575b507f0f5bb82176feb1b5e747e28471aa92156a04d9f3ab9f45f28e2d704232b93f756020604051848152a290565b5f612e679161213b565b5f612e2f565b637475d84d60e11b5f5260045ffd5b50600b541515612daf565b505050505f90565b6001546001600160a01b038083165f8181526005602052604090205492939092909116908115612f775750905b5f5b838110612ecb5750505050565b80612ed76001926120c3565b838060a01b0391549060031b1c16835f52600360205260405f20838060a01b0382165f5260205260405f20549081612f12575b505001612ebe565b845f52600360205260405f20848060a01b0382165f526020525f6040812055612f3c82878361302e565b604051918252847fce405e67b4d6e56e438257e15f160ae28b450e6e7659bbc4c1f4e09a1ac846cb6020868060a01b03891694a45f80612f0a565b905090612ebc565b6009549061ffff8260701c1690815f52600a60205260405f205481831461300957612fb7906001600160701b0385949394169061215d565b6fffffffffffffffffffffffffffffffff19909316607083901b61ffff60701b16176009555b8161ffff821610612fed57505090565b60010161ffff165f818152600a60205260409020839055612fdd565b9250505090565b60025f541461301f5760025f55565b633ee5aeb560e01b5f5260045ffd5b60405163a9059cbb60e01b60208201526001600160a01b039290921660248301526044808301939093529181526125349161306a60648361213b565b61330d565b6001545f5b81811061321757505081158015613206575b612ca9576130b761054b7f0000000000000000000000000000000000000000000000000000000000000000426122ac565b906131956130c58383612821565b50916130d084612f7f565b5060606001600160701b0386169160208501926001600160701b036130f88282875116612482565b1684526001600160701b0361311260095492828416612482565b6dffffffffffffffffffffffffffff199092169116176009556001600160a01b03165f8181526007602052604090819020865181549551928801516001600160f01b03199096166001600160701b03919091161760709290921b600160701b600160e01b03169190911760e09490941b61ffff60e01b1693909317835593612ad6565b6131a183600d5461215d565b600d556131d98330337f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03166132c9565b7f1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee906020604051858152a390565b506001600160701b03821015613086565b806132236001926120c3565b838060a01b0391549060031b1c1661323a81612758565b90805f52600260205281600560405f2001556132558161241c565b815f526002602052600460405f200155838060a01b0386168061327c575b50505001613074565b61328682886122ea565b815f52600360205260405f20868060a01b0384165f5260205260405f20555f52600460205260405f2090848060a01b03165f5260205260405f20555f8080613273565b6040516323b872dd60e01b60208201526001600160a01b0392831660248201529290911660448301526064808301939093529181526125349161306a60848361213b565b905f602091828151910182855af115611dc5575f513d61335c57506001600160a01b0381163b155b61333c5750565b635274afe760e01b5f9081526001600160a01b0391909116600452602490fd5b6001141561333556fea164736f6c634300081c000a60c034607c57601f61022738819003918201601f19168301916001600160401b038311848410176080578084926040948552833981010312607c57604b60206045836094565b92016094565b6080919091526001600160a01b031660a05260405161017f90816100a8823960805181604e015260a0518160a30152f35b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b51906001600160a01b0382168203607c5756fe6080806040526004361015610012575f80fd5b5f3560e01c63f3fef3a314610025575f80fd5b3461011c57604036600319011261011c576004356001600160a01b038116919082900361011c577f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03163303610146575060405163a9059cbb60e01b8152600481019190915260248035908201526020816044815f7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03165af1801561013b576100d957005b60203d602011610134575b601f8101601f1916820167ffffffffffffffff8111838210176101205760209183916040528101031261011c57518015150361011c57005b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b503d6100e4565b6040513d5f823e3d90fd5b62461bcd60e51b815260206004820152600760248201526610a9ba30b5b2b960c91b6044820152606490fdfea164736f6c634300081c000a000000000000000000000000c07e000044f95655c11fda4cd37f70a94d7e0a7d00000000000000000000000010101010e0c3171d894b71b3400668af311e7d94000000000000000000000000419905009e4656fdc02418c7df35b1e61ed5f7260000000000000000000000000000000000000000000000000000000000000002";
            let computedAddress = await create2Factory.computeAddress(salt, ethers.keccak256(initCode));
            console.log("Computed address: "+computedAddress);
            await create2Factory.connect(signers.depl).deploy(0, salt, initCode);
            let expectedAddress = ethers.getCreate2Address(create2FactoryAddress, salt, ethers.keccak256(initCode));
            await expect(await ethers.provider.getCode(expectedAddress)).to.be.not.equal("0x");
            var stakerAbi = [
                "function earned(address _account, address _rewardToken) external view returns (uint256)",
                "function setCooldownEpochs(uint24 _epochs) external",
                "function cooldownEpochs() external view returns (uint)"
            ]
            newStaker = await new ethers.Contract(expectedAddress, stakerAbi, ethers.provider);
            newStakerAddress = expectedAddress;
            await expect(await newStaker.cooldownEpochs()).to.be.equal(2);
        });

        // core changes registry staker address to new staker
        it("Core updates registry to new staker", async () => {
            await registry.connect(signers.core).setStaker(newStakerAddress);
            var stakerInRegistry = await registry.staker();
            await expect(stakerInRegistry).to.be.equal(newStakerAddress);
        });

        // pause unofficial staker to ensure no new pending stakes
        it("Core pauses unofficial staker", async () => {
            await MagicStaker.connect(signers.core).setPaused(true);
            var paused = await MagicStaker.paused();
            await expect(paused).to.be.equal(true);
        });

        // once pending stakes are resolved, core calls migration
        it("Should advance time 1 week", async () => {
            await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine", []);
        });
        it("Core calls migration and unpauses", async () => {
            await expect(MagicStaker.connect(signers.core).migrateStaker()).to.be.not.reverted;
            await expect(MagicStaker.connect(signers.core).setPaused(false)).to.be.not.reverted;
            var paused = await MagicStaker.paused();
            await expect(paused).to.be.equal(false);
        });
        it("Should advance time 1 week", async () => {
            await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine", []);
        });
        // Users can stake or enter cooldowns on new staker
        it("Users can stake on new staker", async () => {
            await expect(MagicStaker.connect(signers.users[0]).stake(1000n*10n**18n)).to.be.not.reverted;
        });
        it("Advance time until cooldown epoch", async () => {
            var isCooldown = false;
            var c = 0;
            while(!isCooldown) {
                await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
                await ethers.provider.send("evm_mine", []);
                isCooldown = await MagicStaker.isCooldownEpoch();
                c++;
            }
            console.log("     > advanced "+c+" weeks to reach cooldown epoch");
        });
        it("Users can enter cooldown on new staker", async () => {
            await expect(MagicStaker.connect(signers.users[0]).cooldown(1000n*10n**18n)).to.be.not.reverted;
        });
        it("Should advance time 3 weeks", async () => {
            await ethers.provider.send("evm_increaseTime", [21 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine", []);
        });
        it("Users can unstake from cooldown on new staker", async () => {
            let balBefore = await RSUP.balanceOf(users[0]);
            await expect(MagicStaker.connect(signers.users[0]).unstake()).to.be.not.reverted;
            let balAfter = await RSUP.balanceOf(users[0]);
            expect(balAfter).to.be.equal(balBefore + 1000n*10n**18n);
        });
    });
});