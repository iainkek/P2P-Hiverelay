// Integration: cheat path end-to-end on-chain. A cheating verdict forfeits the
// cheater (arbitration-bridge), the corrected session re-reduces to the honest
// player, and a relay committee attests THAT result so it settles on-chain
// WITHOUT the cheater's cooperation (they would never co-sign their own loss).

const { ethers } = require('hardhat')
const { expect } = require('chai')
const { attest, aggregate } = require('../attest.cjs')

const U = (n) => BigInt(n) * 1_000_000n
const card = (rank, suit = 0) => rank * 4 + suit

async function setup () {
  const signers = await ethers.getSigners()
  const [, alice, bob, carol] = signers
  const committee = ethers.Wallet.createRandom()
  const USDT = await ethers.getContractFactory('MockUSDT')
  const usdt = await USDT.deploy(); await usdt.waitForDeployment()
  for (const p of [alice, bob, carol]) await usdt.mint(p.address, U(1000))
  const escrowId = ethers.id('table-cheat')
  const Escrow = await ethers.getContractFactory('PokerEscrow')
  const escrow = await Escrow.deploy(escrowId, await usdt.getAddress(), [alice.address, bob.address, carol.address], [committee.address], 1)
  await escrow.waitForDeployment()
  for (const p of [alice, bob, carol]) {
    await usdt.connect(p).approve(await escrow.getAddress(), U(100))
    await escrow.connect(p).deposit(U(100))
  }
  return { usdt, escrow, escrowId, alice, bob, carol, committee }
}

describe('arbitration (cheat) → on-chain settlement', function () {
  it('a cheating verdict forfeits the cheater and settles the honest result on-chain', async function () {
    const { reduce } = await import('../../reducer.js')
    const { applyVerdict } = await import('../../arbitration-bridge.js')
    const { usdt, escrow, escrowId, alice, bob, carol, committee } = await setup()

    // carol holds the best hand (aces) but cheated; alice (kings) > bob (queens).
    const board = [card(7, 0), card(3, 1), card(2, 2), card(0, 3), card(6, 0)]
    const session = {
      seats: ['alice', 'bob', 'carol'],
      hands: [{
        handId: 'h1',
        board,
        contributions: { alice: Number(U(30)), bob: Number(U(30)), carol: Number(U(30)) },
        folded: [],
        reveals: { alice: [card(11, 0), card(11, 1)], bob: [card(10, 0), card(10, 1)], carol: [card(12, 0), card(12, 1)] }
      }]
    }
    // Sanity: if carol were honest she'd win the pot.
    const honest = reduce(session)
    expect(honest.balances.carol).to.equal(Number(U(60)))

    // Verdict: carol (respondent) cheated → forfeits the hand.
    const corrected = applyVerdict(session, { verdict: 'claimant', respondent: 'carol', handId: 'h1' })
    const r = reduce(corrected)
    expect(r.illegal).to.equal(null)
    expect(r.balances.alice).to.equal(Number(U(60))) // alice now takes the 90 pot
    expect(r.balances.bob).to.equal(-Number(U(30)))
    expect(r.balances.carol).to.equal(-Number(U(30))) // cheater loses her contribution

    // Committee attests the corrected result; settles without carol's cooperation.
    const ctx = {
      escrowId,
      participants: ['alice', 'bob', 'carol'],
      seatToAddress: { alice: alice.address, bob: bob.address, carol: carol.address },
      deposits: { alice: U(100), bob: U(100), carol: U(100) },
      reducerResult: r,
      epoch: 1
    }
    const a = await attest({ ...ctx, attestorKey: committee.privateKey })
    await escrow.disputeClose(a.sessionHash, a.epoch, a.payees, a.balances, aggregate([a]))
    for (const p of [alice, bob, carol]) await escrow.connect(p).withdraw()

    expect(await usdt.balanceOf(alice.address)).to.equal(U(1060)) // 900 + 160
    expect(await usdt.balanceOf(bob.address)).to.equal(U(970)) // 900 + 70
    expect(await usdt.balanceOf(carol.address)).to.equal(U(970)) // 900 + 70 — settled net, no extra penalty
  })
})
