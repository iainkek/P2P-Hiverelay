// F-2: deposit credits the MEASURED balance delta, so a fee-on-transfer token
// can't make pot() exceed the real balance (no stranded withdrawal). F-5: the
// Settled event carries (payees, balances).

const { ethers } = require('hardhat')
const { expect } = require('chai')

const U = (n) => BigInt(n) * 1_000_000n
const abi = ethers.AbiCoder.defaultAbiCoder()
const coopDigest = (id, p, b) => ethers.keccak256(abi.encode(['bytes32', 'address[]', 'uint256[]'], [id, p, b]))

describe('PokerEscrow with a fee-on-transfer token (F-2) + Settled event (F-5)', function () {
  it('credits received-after-fee on deposit; pot == real balance; nothing stranded', async function () {
    const [, alice, bob] = await ethers.getSigners()
    const T = await ethers.getContractFactory('FeeToken')
    const tok = await T.deploy(); await tok.waitForDeployment()
    await tok.mint(alice.address, U(1000)); await tok.mint(bob.address, U(1000))
    const escrowId = ethers.id('table-fee')
    const Escrow = await ethers.getContractFactory('PokerEscrow')
    const escrow = await Escrow.deploy(escrowId, await tok.getAddress(), [alice.address, bob.address], [], 0)
    await escrow.waitForDeployment()
    const escrowAddr = await escrow.getAddress()

    // each deposits 100; 1% fee burned → escrow receives 99 each.
    await tok.connect(alice).approve(escrowAddr, U(100)); await escrow.connect(alice).deposit(U(100))
    await tok.connect(bob).approve(escrowAddr, U(100)); await escrow.connect(bob).deposit(U(100))
    expect(await escrow.deposited(alice.address)).to.equal(U(99)) // measured, not 100
    expect(await escrow.pot()).to.equal(U(198))
    expect(await tok.balanceOf(escrowAddr)).to.equal(U(198)) // pot == real balance

    // settle conserving the real pot (198): alice +50 net vs her 99 deposit
    const payees = [alice.address, bob.address]
    const balances = [U(149), U(49)]
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))
    const tx = await escrow.cooperativeClose(payees, balances, [sigA, sigB])

    // F-5: the Settled event carries kind + payees + balances.
    const rc = await tx.wait()
    const ev = rc.logs.map(l => { try { return escrow.interface.parseLog(l) } catch { return null } }).find(e => e && e.name === 'Settled')
    expect(ev.args.kind).to.equal('cooperative')
    expect(ev.args.payees).to.deep.equal(payees)
    expect(ev.args.balances.map(String)).to.deep.equal([U(149), U(49)].map(String))

    // both withdraw → the escrow drains to exactly zero (nothing stranded).
    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()
    expect(await tok.balanceOf(escrowAddr)).to.equal(0n)
  })
})
