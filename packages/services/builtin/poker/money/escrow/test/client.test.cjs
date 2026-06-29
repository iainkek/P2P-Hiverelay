// EscrowClient drives the full on-chain player flow end to end, so a UI can rely
// on one orchestration object: deposit → read state → co-sign net → withdraw.

const { ethers } = require('hardhat')
const { expect } = require('chai')
const { EscrowClient } = require('../client.cjs')

const U = (n) => BigInt(n) * 1_000_000n

async function expectRevert (promise, reason) {
  try { await promise; expect.fail('expected revert "' + reason + '"') } catch (e) { expect(e.message).to.contain(reason) }
}

describe('EscrowClient (on-chain orchestration)', function () {
  async function fixture (committee = [], threshold = 0) {
    const [, alice, bob] = await ethers.getSigners()
    const USDT = await ethers.getContractFactory('MockUSDT')
    const usdt = await USDT.deploy(); await usdt.waitForDeployment()
    await usdt.mint(alice.address, U(1000)); await usdt.mint(bob.address, U(1000))
    const Escrow = await ethers.getContractFactory('PokerEscrow')
    const escrow = await Escrow.deploy(ethers.id('client-table'), await usdt.getAddress(), [alice.address, bob.address], committee, threshold)
    await escrow.waitForDeployment()
    const escrowAddress = await escrow.getAddress()
    const tokenAddress = await usdt.getAddress()
    return { usdt, escrow, escrowAddress, tokenAddress, alice, bob }
  }

  it('deposit → state → cooperative settle → withdraw, all via the client', async function () {
    const { usdt, escrowAddress, tokenAddress, alice, bob } = await fixture()
    const aClient = new EscrowClient({ escrowAddress, tokenAddress, runner: alice })
    const bClient = new EscrowClient({ escrowAddress, tokenAddress, runner: bob })

    // tokenStatus surfaces wallet balance + allowance for the cashier.
    let status = await aClient.tokenStatus()
    expect(status.balance).to.equal(U(1000))
    expect(status.allowance).to.equal(0n)

    await aClient.deposit(U(100)) // approves then deposits
    await bClient.deposit(U(100))

    let state = await aClient.getState([alice.address, bob.address])
    expect(state.pot).to.equal(U(200))
    expect(state.settled).to.equal(false)
    expect(state.seats[alice.address].deposited).to.equal(U(100))
    expect(state.seats[alice.address].isParticipant).to.equal(true)

    const escrowId = await aClient.escrowId()
    const payees = [alice.address, bob.address]
    const balances = [U(150), U(50)] // alice net +50
    const sigA = await aClient.signCooperativeClose(escrowId, payees, balances)
    const sigB = await bClient.signCooperativeClose(escrowId, payees, balances)
    await aClient.cooperativeClose(payees, balances, [sigA, sigB])

    state = await aClient.getState([alice.address, bob.address])
    expect(state.settled).to.equal(true)
    expect(state.seats[alice.address].withdrawable).to.equal(U(150))
    expect(state.seats[bob.address].withdrawable).to.equal(U(50))

    await aClient.withdraw()
    await bClient.withdraw()
    expect(await usdt.balanceOf(alice.address)).to.equal(U(1050))
    expect(await usdt.balanceOf(bob.address)).to.equal(U(950))
  })

  it('finalBalances helper maps a reducer result to (payees, balances)', async function () {
    const { alice, bob } = await fixture()
    const { payees, balances } = EscrowClient.finalBalances(
      ['alice', 'bob'],
      { alice: alice.address, bob: bob.address },
      { alice: U(100), bob: U(100) },
      { alice: Number(U(30)), bob: -Number(U(30)) }
    )
    expect(payees).to.deep.equal([alice.address, bob.address])
    expect(balances).to.deep.equal([U(130), U(70)])
  })

  it('a read-only provider can getState but cannot withdraw', async function () {
    const { escrowAddress, tokenAddress, alice } = await fixture()
    const roClient = new EscrowClient({ escrowAddress, tokenAddress, runner: ethers.provider })
    const state = await roClient.getState([alice.address])
    expect(state.settled).to.equal(false)
    await expectRevert(roClient.withdraw(), '') // provider has no signer → send fails
  })
})
