// HR-side attestation (Phase 03) → on-chain dispute settlement.
// A relay COMMITTEE independently attests the reduced session; a threshold of
// those signatures settles the grief path via disputeClose.

const { ethers } = require('hardhat')
const { expect } = require('chai')
const { attest, aggregate } = require('../attest.cjs')

const U = (n) => BigInt(n) * 1_000_000n
const card = (rank, suit = 0) => rank * 4 + suit

function sampleSession () {
  return {
    seats: ['alice', 'bob'],
    hands: [{
      handId: 'h1',
      board: [card(7, 0), card(3, 1), card(2, 2), card(0, 3), card(6, 0)],
      contributions: { alice: Number(U(30)), bob: Number(U(30)) },
      folded: [],
      reveals: { alice: [card(12, 0), card(12, 1)], bob: [card(11, 0), card(11, 1)] }
    }]
  }
}

async function setup (committeeAddrs, threshold) {
  const [, alice, bob] = await ethers.getSigners()
  const USDT = await ethers.getContractFactory('MockUSDT')
  const usdt = await USDT.deploy(); await usdt.waitForDeployment()
  await usdt.mint(alice.address, U(1000)); await usdt.mint(bob.address, U(1000))
  const escrowId = ethers.id('table-att')
  const Escrow = await ethers.getContractFactory('PokerEscrow')
  const escrow = await Escrow.deploy(escrowId, await usdt.getAddress(), [alice.address, bob.address], committeeAddrs, threshold)
  await escrow.waitForDeployment()
  for (const s of [alice, bob]) {
    await usdt.connect(s).approve(await escrow.getAddress(), U(100))
    await escrow.connect(s).deposit(U(100))
  }
  return { usdt, escrow, escrowId, alice, bob }
}

describe('attestation (Phase 03) → dispute settlement', function () {
  it('a relay committee threshold attests the reducer result and settles', async function () {
    const { reduce } = await import('../../reducer.js')
    // 3 relay attestors, threshold 2-of-3.
    const attestors = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()]
    const committee = attestors.map(a => a.address)
    const { usdt, escrow, escrowId, alice, bob } = await setup(committee, 2)

    const r = reduce(sampleSession())
    const ctx = {
      escrowId,
      participants: ['alice', 'bob'],
      seatToAddress: { alice: alice.address, bob: bob.address },
      deposits: { alice: U(100), bob: U(100) },
      reducerResult: r,
      epoch: 1
    }
    // 2 of 3 relays attest (each independently — same digest).
    const a0 = await attest({ ...ctx, attestorKey: attestors[0].privateKey })
    const a1 = await attest({ ...ctx, attestorKey: attestors[1].privateKey })
    const sigs = aggregate([a0, a1])

    await escrow.disputeClose(a0.sessionHash, a0.epoch, a0.payees, a0.balances, sigs)
    expect(await escrow.settled()).to.equal(true)
    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()
    expect(await usdt.balanceOf(alice.address)).to.equal(U(1030)) // won +30
    expect(await usdt.balanceOf(bob.address)).to.equal(U(970))
  })

  it('below threshold is rejected (NO_QUORUM)', async function () {
    const { reduce } = await import('../../reducer.js')
    const attestors = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()]
    const { usdt, escrow, escrowId, alice, bob } = await setup(attestors.map(a => a.address), 2)
    void usdt
    const r = reduce(sampleSession())
    const ctx = { escrowId, participants: ['alice', 'bob'], seatToAddress: { alice: alice.address, bob: bob.address }, deposits: { alice: U(100), bob: U(100) }, reducerResult: r, epoch: 1 }
    const a0 = await attest({ ...ctx, attestorKey: attestors[0].privateKey }) // only 1
    let reverted = false
    try {
      await escrow.disputeClose(a0.sessionHash, a0.epoch, a0.payees, a0.balances, aggregate([a0]))
    } catch (e) { reverted = /NO_QUORUM/.test(e.message) }
    expect(reverted).to.equal(true)
  })

  it('a non-committee signer does not count toward quorum', async function () {
    const { reduce } = await import('../../reducer.js')
    const attestors = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()]
    const outsider = ethers.Wallet.createRandom()
    const { escrow, escrowId, alice, bob } = await setup(attestors.map(a => a.address), 2)
    const r = reduce(sampleSession())
    const ctx = { escrowId, participants: ['alice', 'bob'], seatToAddress: { alice: alice.address, bob: bob.address }, deposits: { alice: U(100), bob: U(100) }, reducerResult: r, epoch: 1 }
    const good = await attest({ ...ctx, attestorKey: attestors[0].privateKey })
    const bad = await attest({ ...ctx, attestorKey: outsider.privateKey })
    let reverted = false
    try {
      await escrow.disputeClose(good.sessionHash, good.epoch, good.payees, good.balances, aggregate([good, bad]))
    } catch (e) { reverted = /NO_QUORUM/.test(e.message) }
    expect(reverted).to.equal(true) // 1 committee + 1 outsider < threshold 2
  })
})
