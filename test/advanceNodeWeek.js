// TO-DO: test excluded address cutoff

var { ethers } = require("hardhat");

// hello world tests to verify deployments succeeded
describe("Advance 1 week", () => {
    it("Advances 1 week", async () => {
        await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine", []);
    });
});