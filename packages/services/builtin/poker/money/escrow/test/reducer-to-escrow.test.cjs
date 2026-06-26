// Integration: off-chain reducer → on-chain escrow settlement.
// Proves the two halves connect — a played session reduces to net balances,
// and those balances drive the actual USD₮ payout (cooperative + dispute paths).

const { ethers } = require('hardhat')
const { expect } = require('chai')
const { coopDigest, disputeDigest, finalBalances } = require('../settle.cjs')

const U = (n) => BigInt(n) * 1_000_000n // chips == USD₮ base units (6 decimals)
const card = (rank, suit = 0) => rank * 4 + suit

// One hand: alice (aces) beats bob (jacks); both bet 30. alice nets +30.
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

async function setup (committeeAddrs = [], threshold = committeeAddrs.length) {
  const [, alice, bob] = await ethers.getSigners()
  const USDT = await ethers.getContractFactory('MockUSDT')
  const usdt = await USDT.deploy(); await usdt.waitForDeployment()
  await usdt.mint(alice.address, U(1000))
  await usdt.mint(bob.address, U(1000))
  const escrowId = ethers.id('table-int')
  const Escrow = await ethers.getContractFactory('PokerEscrow')
  const escrow = await Escrow.deploy(escrowId, await usdt.getAddress(), [alice.address, bob.address], committeeAddrs, threshold)
  await escrow.waitForDeployment()
  // each seat deposits a 100 USD₮ bankroll
  for (const s of [alice, bob]) {
    await usdt.connect(s).approve(await escrow.getAddress(), U(100))
    await escrow.connect(s).deposit(U(100))
  }
  return { usdt, escrow, escrowId, alice, bob }
}

describe('reducer → escrow integration', function () {
  it('reducer net balances drive the on-chain cooperative close', async function () {
    const { reduce } = await import('../../reducer.js')
    const { usdt, escrow, escrowId, alice, bob } = await setup()

    const r = reduce(sampleSession())
    expect(r.illegal).to.equal(null)
    expect(r.balances.alice).to.equal(Number(U(30)))
    expect(r.balances.bob).to.equal(-Number(U(30)))

    const seatToAddress = { alice: alice.address, bob: bob.address }
    const deposits = { alice: U(100), bob: U(100) }
    const { payees, balances } = finalBalances(['alice', 'bob'], seatToAddress, deposits, r.balances)
    expect(balances).to.deep.equal([U(130), U(70)]) // 100 ± 30

    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))
    await escrow.cooperativeClose(payees, balances, [sigA, sigB])
    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()

    expect(await usdt.balanceOf(alice.address)).to.equal(U(1030)) // 900 + 130
    expect(await usdt.balanceOf(bob.address)).to.equal(U(970)) // 900 + 70
  })

  it('reducer sessionHash + committee attestation drive the on-chain dispute close', async function () {
    const { reduce } = await import('../../reducer.js')
    const committee = (await ethers.getSigners())[4]
    const { usdt, escrow, escrowId, alice, bob } = await setup([committee.address], 1)

    const r = reduce(sampleSession())
    const seatToAddress = { alice: alice.address, bob: bob.address }
    const deposits = { alice: U(100), bob: U(100) }
    const { payees, balances } = finalBalances(['alice', 'bob'], seatToAddress, deposits, r.balances)

    // The committee attests (escrowId, reducer.sessionHash, payees, balances, epoch).
    const epoch = 1
    const digest = disputeDigest(escrowId, '0x' + r.sessionHash, payees, balances, epoch)
    const sig = await committee.signMessage(ethers.getBytes(digest))

    await escrow.disputeClose('0x' + r.sessionHash, epoch, payees, balances, [sig])
    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()
    expect(await usdt.balanceOf(alice.address)).to.equal(U(1030))
    expect(await usdt.balanceOf(bob.address)).to.equal(U(970))
  })
})
