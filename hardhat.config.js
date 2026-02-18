require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.30", // Replace with your desired compiler version
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true
    },
  },
  networks: {
    hardhat: {
      forking: {
        // Use an RPC URL from a provider like Alchemy, Infura, etc.
        url: process.env.MAINNET_RPC_URL || `https://ethereum-rpc.publicnode.com`, // PublicNode RPC
        enabled: process.env.MAINNET_RPC_URL ? true : true, // Enable forking
      },
      chainId: 1
    },
    ui: {
      url: "http://localhost:8547",
      chainId: 1
    }
  }
};
