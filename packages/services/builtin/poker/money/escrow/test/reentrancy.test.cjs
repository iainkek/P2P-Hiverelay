// Proves PokerEscrow resists a reentrant token: the re-entry during a withdraw()
// payout is blocked (CEI zeroes `withdrawable` before the transfer; nonReentrant
// guard backs it), and each payee is paid exactly once (no double-pay).

const { ethers } = require('hardhat')
const { expect } = require('chai')

const U = (n) => BigInt(n) * 1_000_000n
const abi = ethers.AbiCoder.defaultAbiCoder()
const coopDigest = (id, p, b) => ethers.keccak256(abi.encode(['bytes32', 'address[]', 'uint256[]'], [id, p, b]))

describe('PokerEscrow reentrancy resistance', function () {
  it('a reentrant token cannot double-pay; the re-entry is blocked', async function () {
    const [, alice, bob] = await ethers.getSigners()
    const Evil = await ethers.getContractFactory('ReentrantToken')
    const evil = await Evil.deploy(); await evil.waitForDeployment()
    await evil.mint(alice.address, U(1000))
    await evil.mint(bob.address, U(1000))

    const escrowId = ethers.id('table-evil')
    const Escrow = await ethers.getContractFactory('PokerEscrow')
    const escrow = await Escrow.deploy(escrowId, await evil.getAddress(), [alice.address, bob.address], [], 0)
    await escrow.waitForDeployment()
    const escrowAddr = await escrow.getAddress()

    await evil.connect(alice).approve(escrowAddr, U(100))
    await escrow.connect(alice).deposit(U(100))
    await evil.connect(bob).approve(escrowAddr, U(100))
    await escrow.connect(bob).deposit(U(100))

    const payees = [alice.address, bob.address]
    const balances = [U(150), U(50)]
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))
    await escrow.cooperativeClose(payees, balances, [sigA, sigB]) // settles net (no transfer)

    // Arm the token to re-enter withdraw() on its next transfer (the payout).
    await evil.arm(escrowAddr)
    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()

    // Each seat was paid exactly once (no double-pay), and the re-entry was caught.
    expect(await evil.balanceOf(alice.address)).to.equal(U(1050)) // 900 left + 150, once
    expect(await evil.balanceOf(bob.address)).to.equal(U(950))
    expect(await evil.reentryReverted()).to.equal(true) // the re-entry was blocked
    expect(await escrow.settled()).to.equal(true)
  })
})
