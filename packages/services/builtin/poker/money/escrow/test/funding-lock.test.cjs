// F-4: an opt-in funding lock freezes deposits so a settlement can't be
// invalidated by a late top-up (threat T-9). Settlement still works once locked.

const { ethers } = require('hardhat')
const { expect } = require('chai')

const U = (n) => BigInt(n) * 1_000_000n
const abi = ethers.AbiCoder.defaultAbiCoder()
const coopDigest = (id, p, b) => ethers.keccak256(abi.encode(['bytes32', 'address[]', 'uint256[]'], [id, p, b]))

async function expectRevert (promise, reason) {
  try { await promise; expect.fail('expected revert "' + reason + '"') } catch (e) { expect(e.message).to.contain(reason) }
}

describe('PokerEscrow funding lock (F-4)', function () {
  async function fixture () {
    const [, alice, bob, stranger] = await ethers.getSigners()
    const USDT = await ethers.getContractFactory('MockUSDT')
    const usdt = await USDT.deploy(); await usdt.waitForDeployment()
    await usdt.mint(alice.address, U(1000)); await usdt.mint(bob.address, U(1000))
    const escrowId = ethers.id('table-lock')
    const Escrow = await ethers.getContractFactory('PokerEscrow')
    const escrow = await Escrow.deploy(escrowId, await usdt.getAddress(), [alice.address, bob.address], [], 0)
    await escrow.waitForDeployment()
    const addr = await escrow.getAddress()
    for (const s of [alice, bob]) { await usdt.connect(s).approve(addr, U(1000)) }
    return { usdt, escrow, escrowId, addr, alice, bob, stranger }
  }

  it('deposits work until a seat closes funding; then they revert', async function () {
    const { escrow, alice, bob } = await fixture()
    await escrow.connect(alice).deposit(U(100))
    await escrow.connect(bob).deposit(U(100))
    expect(await escrow.fundingClosed()).to.equal(false)

    await escrow.connect(alice).closeFunding()
    expect(await escrow.fundingClosed()).to.equal(true)
    await expectRevert(escrow.connect(bob).deposit(U(10)), 'FUNDING_CLOSED')
    await expectRevert(escrow.connect(alice).deposit(U(10)), 'FUNDING_CLOSED')
  })

  it('only a seat can close funding, and only once', async function () {
    const { escrow, alice, stranger } = await fixture()
    await expectRevert(escrow.connect(stranger).closeFunding(), 'NOT_SEAT')
    await escrow.connect(alice).closeFunding()
    await expectRevert(escrow.connect(alice).closeFunding(), 'ALREADY_CLOSED')
  })

  it('settlement + withdraw still work after funding is locked', async function () {
    const { usdt, escrow, escrowId, alice, bob } = await fixture()
    await escrow.connect(alice).deposit(U(100))
    await escrow.connect(bob).deposit(U(100))
    await escrow.connect(bob).closeFunding() // lock — pot is now stable at 200

    const payees = [alice.address, bob.address]
    const balances = [U(150), U(50)]
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))
    await escrow.cooperativeClose(payees, balances, [sigA, sigB])
    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()
    expect(await usdt.balanceOf(alice.address)).to.equal(U(1050)) // 900 left + 150
    expect(await usdt.balanceOf(bob.address)).to.equal(U(950)) // 900 left + 50
  })
})
