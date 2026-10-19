require("@nomicfoundation/hardhat-toolbox");

const USRSUP_COMPILER = {
  version: "0.8.30",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    evmVersion: "prague", // solc 0.8.30's default EVM version (the magic contracts stay on paris)
  },
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.30",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true, // magic contracts need via-IR for contract size
          evmVersion: "paris", // pinned: the deployed magic contracts were built for paris
        },
      },
    ],
    // usRSUP, plus the OpenZeppelin 5.6 files it pulls in that need Cancun+ opcodes (mcopy), compile on the legacy
    // pipeline for the latest EVM version. Keep in sync with the settings in usRSUP.md.
    // The magic contracts keep the default settings above.
    overrides: Object.fromEntries(
      [
        "contracts/usRSUP.sol",
        "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol", // uses Memory (mcopy) since 5.6
        "@openzeppelin/contracts/utils/Memory.sol",
      ].map((file) => [file, USRSUP_COMPILER])
    ),
  },
  networks: {
    hardhat: {
      forking: {
        // Use an RPC URL from a provider like Alchemy, Infura, etc.
        url: process.env.MAINNET_RPC_URL || `https://ethereum-rpc.publicnode.com`, // PublicNode RPC
        enabled: true,
        // Optional pin for reproducible runs. Needs an archive RPC in MAINNET_RPC_URL: the public RPC only serves
        // recent state, so by default the fork starts at the latest block and the tests read live state.
        ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}),
      },
      chainId: 1
    },
    ui: {
      url: "http://localhost:8547",
      chainId: 1
    }
  }
};
