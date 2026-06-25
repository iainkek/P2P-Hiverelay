require('@nomicfoundation/hardhat-ethers')

// Testnet wiring is env-driven so no secrets live in the repo. Set:
//   TESTNET_RPC_URL      e.g. an Arbitrum/Base Sepolia RPC
//   TESTNET_PRIVATE_KEY  a FUNDED testnet key (gas)
// then: npx hardhat run scripts/deploy.cjs --network testnet
const RPC = process.env.TESTNET_RPC_URL
const KEY = process.env.TESTNET_PRIVATE_KEY

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    ...(RPC && KEY ? { testnet: { url: RPC, accounts: [KEY] } } : {})
  }
}
