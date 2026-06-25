// wdk-signer.cjs — adapter from Tether WDK (@tetherto/wdk-wallet-evm) to the
// minimal signer the escrow flow needs (Phase 07). WDK is the production
// self-custody player wallet: BIP-39 seed → BIP-44 EVM account, EIP-191/712
// signing, sendTransaction (arbitrary contract calls), ERC-20 approve, and
// EIP-7702 gasless delegation. It is ethers-based and takes a plain RPC URL as
// its provider (no mandatory Tether-hosted indexer).
//
// WDK ships ESM; this CJS adapter dynamic-imports it so the hardhat/ethers
// tooling can drive it. The escrow flow only needs: address, sign(digest),
// sendTransaction, approve — all native to WalletAccountEvm.

/**
 * Derive a WDK EVM account and expose the escrow-relevant primitives.
 * @param {string} seedPhrase  BIP-39 mnemonic
 * @param {string} rpcUrl      EVM RPC URL (e.g. a Sepolia endpoint)
 * @param {number} [index=0]   account index (BIP-44 m/44'/60'/index)
 * @returns {Promise<{ address, account, wallet, sign(bytes), dispose() }>}
 */
async function wdkAccount (seedPhrase, rpcUrl, index = 0) {
  const mod = await import('@tetherto/wdk-wallet-evm')
  const WalletManagerEvm = mod.default
  const wallet = new WalletManagerEvm(seedPhrase, { provider: rpcUrl })
  const account = await wallet.getAccount(index)
  const address = await account.getAddress()
  return {
    address,
    account,
    wallet,
    // Personal-sign (EIP-191) over the given bytes — escrow cooperativeClose /
    // disputeClose digests are signed this way and recovered via ecrecover.
    sign: (bytes) => account.sign(bytes),
    dispose: () => wallet.dispose()
  }
}

module.exports = { wdkAccount }
