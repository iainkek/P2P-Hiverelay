// WDK wallet integration (Phase 07): prove a Tether WDK player wallet is
// interoperable with the escrow — (1) it derives standard BIP-44 EVM addresses,
// (2) its signatures are accepted by the escrow's ecrecover path.

const { ethers } = require('hardhat')
const { expect } = require('chai')
const { wdkAccount } = require('../wallet/wdk-signer.cjs')
const { coopDigest } = require('../settle.cjs')

// Canonical zero-seed (BIP-39 test vector). Account 0 has a well-known address.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RPC = 'https://sepolia.drpc.org' // only used for sendTransaction; derivation/signing are offline

describe('WDK wallet (Phase 07) ↔ escrow interop', function () {
  this.timeout(60000)

  it('derives the standard BIP-44 EVM address (interoperable with any tooling)', async function () {
    const w = await wdkAccount(SEED, RPC, 0)
    const expected = ethers.HDNodeWallet.fromPhrase(SEED).address // m/44'/60'/0'/0/0
    expect(w.address.toLowerCase()).to.equal(expected.toLowerCase())
    w.dispose()
  })

  it('a WDK signature over a cooperativeClose digest recovers to the WDK address', async function () {
    const w = await wdkAccount(SEED, RPC, 0)
    const escrowId = ethers.id('table-wdk')
    const payees = [w.address, ethers.ZeroAddress]
    const balances = [123n, 0n]
    const digest = coopDigest(escrowId, payees, balances)

    const sig = await w.sign(ethers.getBytes(digest))
    // The escrow recovers EIP-191 personal-sign over the 32-byte digest.
    const recovered = ethers.verifyMessage(ethers.getBytes(digest), sig)
    expect(recovered.toLowerCase()).to.equal(w.address.toLowerCase())
    w.dispose()
  })
})
