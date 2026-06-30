// dispute-demo.cjs — proves the GRIEF/STALL settlement path on a real testnet: a
// relay committee attests the canonical net and `disputeClose` settles it WITHOUT
// the players' cooperation. Companion to live-demo.cjs (the cooperative path).
//
//   TESTNET_RPC_URL=https://sepolia.base.org \
//   TESTNET_PRIVATE_KEY=0x<funded-key> \
//   node scripts/dispute-demo.cjs

const { JsonRpcProvider, Wallet, ContractFactory, getBytes, id, parseEther, formatEther } = require('ethers')
const { disputeDigest } = require('../settle.cjs')
const escrowArt = require('../artifacts/contracts/PokerEscrow.sol/PokerEscrow.json')
const usdtArt = require('../artifacts/contracts/MockUSDT.sol/MockUSDT.json')
const fs = require('fs')
const path = require('path')

const U = (n) => BigInt(n) * 1_000_000n
const fmt = (x) => (Number(x) / 1e6).toFixed(2)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const RPC = process.env.TESTNET_RPC_URL
const KEY = process.env.TESTNET_PRIVATE_KEY
if (!RPC || !KEY) { console.error('set TESTNET_RPC_URL and TESTNET_PRIVATE_KEY'); process.exit(1) }

async function main () {
  const provider = new JsonRpcProvider(RPC)
  const untilGte = async (fn, want, label, tries = 40) => { for (let i = 0; i < tries; i++) { let v = 0n; try { v = BigInt(await fn()) } catch {} if (v >= BigInt(want)) return v; await sleep(1500) } throw new Error('timeout: ' + label) }
  const untilCode = async (addr, label, tries = 40) => { for (let i = 0; i < tries; i++) { const c = await provider.getCode(addr); if (c && c !== '0x') return; await sleep(1500) } throw new Error('no code: ' + label) }
  const net = await provider.getNetwork()
  const A = new Wallet(KEY, provider) // deployer + player A
  const B = Wallet.createRandom().connect(provider) // ephemeral player B
  const C = Wallet.createRandom() // relay committee attestor (signs off-chain only — no gas)
  const txs = {}
  const log = (k, label, tx) => { txs[k] = tx.hash; console.log('  ' + label.padEnd(22) + tx.hash) }

  console.log('\n══════════ P2Poker — live DISPUTE (committee) proof ══════════')
  console.log('network    : ' + net.name + ' (chainId ' + net.chainId + ')')
  console.log('player A   : ' + A.address + '  (' + formatEther(await provider.getBalance(A.address)) + ' ETH)')
  console.log('player B   : ' + B.address + '  (ephemeral)')
  console.log('committee  : ' + C.address + '  (off-chain attestor, 1-of-1)')

  let tx = await A.sendTransaction({ to: B.address, value: parseEther('0.006') }); await tx.wait(); log('fundB', 'fund B', tx)

  console.log('\n[1] deploy MockUSDT + PokerEscrow (committee = [C], threshold 1)')
  const usdt = await new ContractFactory(usdtArt.abi, usdtArt.bytecode, A).deploy()
  await usdt.waitForDeployment(); const usdtAddr = await usdt.getAddress()
  const escrowId = id('base-sepolia-dispute-' + net.chainId)
  const escrow = await new ContractFactory(escrowArt.abi, escrowArt.bytecode, A).deploy(escrowId, usdtAddr, [A.address, B.address], [C.address], 1)
  await escrow.waitForDeployment(); const escrowAddr = await escrow.getAddress()
  console.log('  MockUSDT             ' + usdtAddr)
  console.log('  PokerEscrow          ' + escrowAddr)
  await untilCode(usdtAddr, 'MockUSDT'); await untilCode(escrowAddr, 'PokerEscrow')

  console.log('\n[2] mint + each deposits 100 USD₮')
  tx = await usdt.connect(A).mint(A.address, U(1000)); await tx.wait()
  tx = await usdt.connect(B).mint(B.address, U(1000)); await tx.wait()
  await untilGte(() => usdt.balanceOf(A.address), U(1000), 'A bal'); await untilGte(() => usdt.balanceOf(B.address), U(1000), 'B bal')
  tx = await usdt.connect(A).approve(escrowAddr, U(100)); await tx.wait(); await untilGte(() => usdt.allowance(A.address, escrowAddr), U(100), 'A allow')
  tx = await escrow.connect(A).deposit(U(100)); await tx.wait(); log('depA', 'A deposit', tx)
  tx = await usdt.connect(B).approve(escrowAddr, U(100)); await tx.wait(); await untilGte(() => usdt.allowance(B.address, escrowAddr), U(100), 'B allow')
  tx = await escrow.connect(B).deposit(U(100)); await tx.wait(); log('depB', 'B deposit', tx)
  await untilGte(() => escrow.pot(), U(200), 'pot')
  console.log('  pot                  ' + fmt(await escrow.pot()) + ' USD₮')

  console.log('\n[3] committee attests the canonical net (B wins): A=50, B=150 — A never co-signs')
  const sessionHash = id('demo-dispute-session-1')
  const epoch = 1
  const payees = [A.address, B.address]
  const balances = [U(50), U(150)]
  const digest = disputeDigest(escrowId, sessionHash, payees, balances, epoch)
  const sig = await C.signMessage(getBytes(digest))
  tx = await escrow.connect(A).disputeClose(sessionHash, epoch, payees, balances, [sig]); await tx.wait(); log('dispute', 'disputeClose', tx)
  await untilGte(async () => (await escrow.settled()) ? 1n : 0n, 1, 'settled')
  console.log('  settled (dispute)    ' + (await escrow.settled()))

  console.log('\n[4] each withdraws their committee-settled net')
  await untilGte(() => escrow.withdrawable(B.address), U(150), 'B withdrawable')
  tx = await escrow.connect(B).withdraw(); await tx.wait(); log('wdB', 'B withdraw', tx)
  await untilGte(() => escrow.withdrawable(A.address), U(50), 'A withdrawable')
  tx = await escrow.connect(A).withdraw(); await tx.wait(); log('wdA', 'A withdraw', tx)
  await untilGte(() => usdt.balanceOf(B.address), U(1050), 'B final')

  const balA = await usdt.balanceOf(A.address); const balB = await usdt.balanceOf(B.address)
  console.log('\n[5] final USD₮ balances:')
  console.log('  A  ' + fmt(balA) + '    (1000 - 100 +  50 =  950 ✓ ' + (balA === U(950)) + ')')
  console.log('  B  ' + fmt(balB) + '   (1000 - 100 + 150 = 1050 ✓ ' + (balB === U(1050)) + ')')

  const out = { chainId: net.chainId.toString(), path: 'dispute', usdt: usdtAddr, escrow: escrowAddr, escrowId, committee: C.address, players: { A: A.address, B: B.address }, txs, settledAt: new Date().toISOString() }
  fs.writeFileSync(path.join(__dirname, '..', 'live-dispute-deployment.json'), JSON.stringify(out, null, 2) + '\n')
  console.log('\n══════════ DISPUTE PROOF OK — committee-attested settlement on ' + net.name + ' ══════════\n')
}

main().catch((e) => { console.error('FAILED:', e.shortMessage || e.message); process.exitCode = 1 })
