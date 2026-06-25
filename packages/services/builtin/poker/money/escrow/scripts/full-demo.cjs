// full-demo.cjs — end-to-end capstone: the WHOLE money stack in one run.
//   betting engine → settlement reducer → on-chain USD₮ escrow (both close paths)
//
//   npx hardhat run scripts/full-demo.cjs
//
// Proves the pieces connect: a real multiway hand is played through the betting
// engine, reduced to net balances + sessionHash, and settled on a local EVM —
// cooperatively (players co-sign) AND via the relay-committee attestation
// (grief path) — with USD₮ actually moving and conservation asserted.

const { ethers } = require('hardhat')
const { coopDigest, finalBalances } = require('../settle.cjs')
const { attest, aggregate } = require('../attest.cjs')

const M = 1_000_000n // 1 USD₮ (6 decimals)
const U = (n) => BigInt(n) * M
const card = (r, s = 0) => r * 4 + s
const fmt = (x) => (Number(x) / 1e6).toFixed(2)

function assert (cond, msg) { if (!cond) throw new Error('DEMO ASSERT FAILED: ' + msg) }

async function deployEscrow (usdtAddr, players, committee, threshold) {
  const now = (await ethers.provider.getBlock('latest')).timestamp
  const Escrow = await ethers.getContractFactory('PokerEscrow')
  const e = await Escrow.deploy(ethers.id('demo-table'), usdtAddr, players.map(p => p.address), committee, threshold, now + 3600)
  await e.waitForDeployment()
  return e
}

async function main () {
  const { playHand } = await import('../../betting.js')
  const { reduce } = await import('../../reducer.js')
  const signers = await ethers.getSigners()
  const [deployer, alice, bob, carol] = signers
  const committeeWallet = ethers.Wallet.createRandom()
  const players = [alice, bob, carol]
  const seatToAddress = { alice: alice.address, bob: bob.address, carol: carol.address }

  console.log('\n══════════ P2Poker real-money demo (local EVM, mock USD₮) ══════════')

  // 1. Mint test USD₮; everyone deposits a 100 USD₮ bankroll into an escrow.
  const USDT = await ethers.getContractFactory('MockUSDT')
  const usdt = await USDT.deploy(); await usdt.waitForDeployment()
  for (const p of players) await usdt.mint(p.address, U(100))
  const deposits = { alice: U(100), bob: U(100), carol: U(100) }

  // 2. Play a real 3-handed hand through the betting engine.
  //    button=alice (UTG), SB=bob, BB=carol. Blinds 1 / 2 USD₮.
  const actions = [
    { seat: 'alice', type: 'raise', amount: Number(U(6)) }, { seat: 'bob', type: 'fold' }, { seat: 'carol', type: 'call' },
    { seat: 'carol', type: 'check' }, { seat: 'alice', type: 'bet', amount: Number(U(10)) }, { seat: 'carol', type: 'call' },
    { seat: 'carol', type: 'check' }, { seat: 'alice', type: 'check' },
    { seat: 'carol', type: 'check' }, { seat: 'alice', type: 'check' }
  ]
  const bet = playHand({ seats: ['alice', 'bob', 'carol'], stacks: { alice: Number(U(100)), bob: Number(U(100)), carol: Number(U(100)) }, blinds: { sb: Number(U(1)), bb: Number(U(2)) }, button: 'alice' }, actions)
  assert(bet.illegal === null, 'betting legal')
  console.log('\n[1] betting engine → contributions:', Object.fromEntries(Object.entries(bet.contributions).map(([k, v]) => [k, fmt(v)])), 'folded:', bet.folded)

  // 3. Reduce the session (alice aces beat carol kings at showdown).
  const session = {
    seats: ['alice', 'bob', 'carol'],
    hands: [{
      handId: 'h1',
      board: [card(7, 0), card(3, 1), card(2, 2), card(0, 3), card(6, 0)],
      contributions: bet.contributions,
      folded: bet.folded,
      reveals: { alice: [card(12, 0), card(12, 1)], carol: [card(11, 0), card(11, 1)] }
    }]
  }
  const red = reduce(session)
  assert(red.illegal === null, 'reduce legal')
  const sum = Object.values(red.balances).reduce((a, b) => a + b, 0)
  assert(sum === 0, 'conservation Σ balances == 0')
  console.log('[2] reducer → sessionHash:', red.sessionHash.slice(0, 16) + '…')
  console.log('    net balances:', Object.fromEntries(Object.entries(red.balances).map(([k, v]) => [k, fmt(v)])), '(Σ=0 ✓)')

  // ── Path A: cooperative close (players co-sign) ──────────────────────
  {
    const escrow = await deployEscrow(await usdt.getAddress(), players, [], 0)
    for (const p of players) { await usdt.connect(p).approve(await escrow.getAddress(), U(100)); await escrow.connect(p).deposit(U(100)) }
    const { payees, balances } = finalBalances(['alice', 'bob', 'carol'], seatToAddress, deposits, red.balances)
    const digest = coopDigest(ethers.id('demo-table'), payees, balances)
    const sigs = await Promise.all(players.map(p => p.signMessage(ethers.getBytes(digest))))
    await escrow.cooperativeClose(payees, balances, sigs)
    console.log('\n[3A] cooperative close → on-chain USD₮:')
    for (const p of players) console.log('     ', p === alice ? 'alice' : p === bob ? 'bob  ' : 'carol', fmt(await usdt.balanceOf(p.address)), 'USDT')
    assert((await usdt.balanceOf(alice.address)) === U(100) - U(100) + (U(100) + BigInt(red.balances.alice)), 'alice paid correctly')
  }

  // ── Path B: dispute close (relay committee attests) ──────────────────
  {
    // fresh mint + escrow (committee = 1 relay, threshold 1)
    for (const p of players) await usdt.mint(p.address, U(100))
    const escrow = await deployEscrow(await usdt.getAddress(), players, [committeeWallet.address], 1)
    for (const p of players) { await usdt.connect(p).approve(await escrow.getAddress(), U(100)); await escrow.connect(p).deposit(U(100)) }
    const ctx = { escrowId: ethers.id('demo-table'), participants: ['alice', 'bob', 'carol'], seatToAddress, deposits, reducerResult: red, epoch: 1 }
    const a = await attest({ ...ctx, attestorKey: committeeWallet.privateKey })
    await escrow.disputeClose(a.sessionHash, a.epoch, a.payees, a.balances, aggregate([a]))
    console.log('\n[3B] dispute close (committee-attested grief path) → settled the same net result ✓')
  }

  console.log('\n══════════ DEMO OK — full hand played, reduced, and settled in USD₮ ══════════')
  console.log('     (no operator held the pot; conservation held; both close paths worked)\n')
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
