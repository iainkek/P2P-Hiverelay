const { ethers } = require('hardhat')
const { expect } = require('chai')

const U = (n) => BigInt(n) * 1_000_000n // USD₮ has 6 decimals

// Dependency-free revert assertion (no hardhat-chai-matchers needed).
async function expectRevert (promise, reason) {
  try {
    await promise
    expect.fail('expected revert "' + reason + '" but call succeeded')
  } catch (e) {
    expect(e.message).to.contain(reason)
  }
}

const abi = ethers.AbiCoder.defaultAbiCoder()
const coopDigest = (escrowId, payees, balances) =>
  ethers.keccak256(abi.encode(['bytes32', 'address[]', 'uint256[]'], [escrowId, payees, balances]))
const disputeDigest = (escrowId, sessionHash, payees, balances, epoch) =>
  ethers.keccak256(abi.encode(['bytes32', 'bytes32', 'address[]', 'uint256[]', 'uint256'], [escrowId, sessionHash, payees, balances, epoch]))

async function deploy (committeeAddrs = [], threshold = committeeAddrs.length) {
  const [, alice, bob] = await ethers.getSigners()
  const USDT = await ethers.getContractFactory('MockUSDT')
  const usdt = await USDT.deploy()
  await usdt.waitForDeployment()
  await usdt.mint(alice.address, U(1000))
  await usdt.mint(bob.address, U(1000))

  const escrowId = ethers.id('table-1')
  const Escrow = await ethers.getContractFactory('PokerEscrow')
  const escrow = await Escrow.deploy(
    escrowId, await usdt.getAddress(),
    [alice.address, bob.address],
    committeeAddrs, threshold
  )
  await escrow.waitForDeployment()
  return { usdt, escrow, escrowId, alice, bob }
}

async function fund (usdt, escrow, alice, bob, amt = U(100)) {
  await usdt.connect(alice).approve(await escrow.getAddress(), amt)
  await escrow.connect(alice).deposit(amt)
  await usdt.connect(bob).approve(await escrow.getAddress(), amt)
  await escrow.connect(bob).deposit(amt)
}

describe('PokerEscrow (USD₮ state channel)', function () {
  it('deposit → cooperativeClose settles net; each seat pulls via withdraw()', async function () {
    const { usdt, escrow, escrowId, alice, bob } = await deploy()
    await fund(usdt, escrow, alice, bob) // pot = 200
    expect(await escrow.pot()).to.equal(U(200))

    // Final NET balances: alice 150, bob 50.
    const payees = [alice.address, bob.address]
    const balances = [U(150), U(50)]
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))

    await escrow.cooperativeClose(payees, balances, [sigA, sigB])
    expect(await escrow.settled()).to.equal(true)
    // Settlement records the net; no tokens have moved yet (pull-based).
    expect(await usdt.balanceOf(alice.address)).to.equal(U(900))
    expect(await escrow.withdrawable(alice.address)).to.equal(U(150))

    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()
    expect(await usdt.balanceOf(alice.address)).to.equal(U(1050)) // 900 left + 150
    expect(await usdt.balanceOf(bob.address)).to.equal(U(950)) // 900 left + 50
  })

  it('rejects a cooperativeClose that does not conserve the pot', async function () {
    const { usdt, escrow, escrowId, alice, bob } = await deploy()
    await fund(usdt, escrow, alice, bob)
    const payees = [alice.address, bob.address]
    const balances = [U(150), U(100)] // sums to 250 != pot 200
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))
    await expectRevert(escrow.cooperativeClose(payees, balances, [sigA, sigB]), 'NOT_CONSERVED')
  })

  it('rejects cooperativeClose missing a participant signature', async function () {
    const { usdt, escrow, escrowId, alice, bob } = await deploy()
    await fund(usdt, escrow, alice, bob)
    const payees = [alice.address, bob.address]
    const balances = [U(150), U(50)]
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    await expectRevert(escrow.cooperativeClose(payees, balances, [sigA, sigA]), 'NOT_ALL_SIGNED')
  })

  it('disputeClose settles via a committee attestation (oracle path)', async function () {
    const committee = (await ethers.getSigners())[4]
    const { usdt, escrow, escrowId, alice, bob } = await deploy([committee.address], 1)
    await fund(usdt, escrow, alice, bob)

    const sessionHash = ethers.id('session-1')
    const epoch = 1
    const payees = [alice.address, bob.address]
    const balances = [U(40), U(160)] // bob won per the verdict
    const digest = disputeDigest(escrowId, sessionHash, payees, balances, epoch)
    const sig = await committee.signMessage(ethers.getBytes(digest))

    await escrow.disputeClose(sessionHash, epoch, payees, balances, [sig])
    expect(await escrow.settled()).to.equal(true)
    await escrow.connect(alice).withdraw()
    await escrow.connect(bob).withdraw()
    expect(await usdt.balanceOf(bob.address)).to.equal(U(1060)) // 900 + 160
    expect(await usdt.balanceOf(alice.address)).to.equal(U(940)) // 900 + 40
  })

  it('disputeClose rejects a non-committee attestation', async function () {
    const committee = (await ethers.getSigners())[4]
    const stranger = (await ethers.getSigners())[5]
    const { usdt, escrow, escrowId, alice, bob } = await deploy([committee.address], 1)
    await fund(usdt, escrow, alice, bob)
    const sessionHash = ethers.id('session-1')
    const payees = [alice.address, bob.address]
    const balances = [U(0), U(200)]
    const digest = disputeDigest(escrowId, sessionHash, payees, balances, 1)
    const sig = await stranger.signMessage(ethers.getBytes(digest))
    await expectRevert(escrow.disputeClose(sessionHash, 1, payees, balances, [sig]), 'NO_QUORUM')
  })
})

// withdraw-net model: a seat only ever takes out its settled NET — there is no
// path to reclaim a full deposit and escape a loss, and no payout before settle.
describe('PokerEscrow withdraw (deposit / play / withdraw-net)', function () {
  async function settled (balances) {
    const { usdt, escrow, escrowId, alice, bob } = await deploy()
    await fund(usdt, escrow, alice, bob) // each deposits 100; pot 200
    const payees = [alice.address, bob.address]
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))
    await escrow.cooperativeClose(payees, balances, [sigA, sigB])
    return { usdt, escrow, alice, bob }
  }

  it('a losing seat can only withdraw its NET, never its full deposit', async function () {
    // alice lost 60 (net 40); she deposited 100 but can only pull 40.
    const { usdt, escrow, alice } = await settled([U(40), U(160)])
    expect(await escrow.withdrawable(alice.address)).to.equal(U(40))
    await escrow.connect(alice).withdraw()
    expect(await usdt.balanceOf(alice.address)).to.equal(U(940)) // 900 + 40, NOT 1000
  })

  it('withdraw zeroes the balance — a second withdraw reverts', async function () {
    const { escrow, alice } = await settled([U(150), U(50)])
    await escrow.connect(alice).withdraw()
    expect(await escrow.withdrawable(alice.address)).to.equal(0n)
    await expectRevert(escrow.connect(alice).withdraw(), 'NOTHING')
  })

  it('a seat that settled to zero net has nothing to withdraw', async function () {
    const { escrow, alice, bob } = await settled([U(0), U(200)])
    await expectRevert(escrow.connect(alice).withdraw(), 'NOTHING')
    await escrow.connect(bob).withdraw() // bob took the whole pot
  })

  it('cannot withdraw before the session is settled', async function () {
    const { usdt, escrow, alice, bob } = await deploy()
    await fund(usdt, escrow, alice, bob)
    await expectRevert(escrow.connect(alice).withdraw(), 'NOT_SETTLED')
  })

  it('cannot deposit or re-settle after settlement', async function () {
    const { usdt, escrow, escrowId, alice, bob } = await deploy()
    await fund(usdt, escrow, alice, bob)
    const payees = [alice.address, bob.address]
    const balances = [U(150), U(50)]
    const digest = coopDigest(escrowId, payees, balances)
    const sigA = await alice.signMessage(ethers.getBytes(digest))
    const sigB = await bob.signMessage(ethers.getBytes(digest))
    await escrow.cooperativeClose(payees, balances, [sigA, sigB])
    await usdt.connect(alice).approve(await escrow.getAddress(), U(10))
    await expectRevert(escrow.connect(alice).deposit(U(10)), 'SETTLED')
    await expectRevert(escrow.cooperativeClose(payees, balances, [sigA, sigB]), 'SETTLED')
  })
})
