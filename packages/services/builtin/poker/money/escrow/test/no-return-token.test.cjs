// Proves PokerEscrow works with a non-standard, no-return-value ERC-20 (like
// mainnet USDT) via its SafeERC20-style _safeTransfer/_safeTransferFrom — the
// F-1 finding in SECURITY.md. The standard MockUSDT returns a bool, so it does
// NOT exercise this path; NoReturnToken does.

const { ethers } = require('hardhat')
const { expect } = require('chai')

const U = (n) => BigInt(n) * 1_000_000n
const abi = ethers.AbiCoder.defaultAbiCoder()
const coopDigest = (id, p, b) => ethers.keccak256(abi.encode(['bytes32', 'address[]', 'uint256[]'], [id, p, b]))

describe('PokerEscrow with a no-return ERC-20 (mainnet-USDT-like)', function () {
  it('deposit → cooperative settle → withdraw all work against a no-return token', async function () {
    const [, alice, bob] = await ethers.getSigners()
    const T = await ethers.getContractFactory('NoReturnToken')
    const usdt = await T.deploy(); await usdt.waitForDeployment()
    await usdt.mint(alice.address, U(1000))
    await usdt.mint(bob.address, U(1000))

    const escrowId = ethers.id('table-noret')
    const Escrow = await ethers.getContractFactory('PokerEscrow')
    const escrow = await Escrow.deploy(escrowId, await usdt.getAddress(), [alice.address, bob.address], [], 0)
    await escrow.waitForDeployment()
    const escrowAddr = await escrow.getAddress()

    // deposit (exercises _safeTransferFrom on a no-return token)
    await usdt.connect(alice).approve(escrowAddr, U(100))
    await escrow.connect(alice).deposit(U(100))
    await usdt.connect(bob).approve(escrowAddr, U(100))
    await escrow.connect(bob).deposit(U(100))
    expect(await escrow.pot()).to.equal(U(200))

    // cooperative settle: alice net +50
    const payees = [alice.address, bob.address]
    const balances = [U(150), U(50)]
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))
    await escrow.cooperativeClose(payees, balances, [sigA, sigB])

    // withdraw (exercises _safeTransfer on a no-return token)
    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()
    expect(await usdt.balanceOf(alice.address)).to.equal(U(1050)) // 900 + 150
    expect(await usdt.balanceOf(bob.address)).to.equal(U(950)) // 900 + 50
  })
})
