// live-demo.cjs — a full on-chain proof on a real testnet: deploy MockUSDT +
// PokerEscrow, then drive a 2-player deposit → cooperativeClose → withdraw cycle
// and report addresses, tx hashes, and final balances.
//
//   TESTNET_RPC_URL=https://sepolia.base.org \
//   TESTNET_PRIVATE_KEY=0x<funded-key> \
//   node scripts/live-demo.cjs
//
// Player A is the funded deployer; player B is an ephemeral wallet A funds with a
// little gas. No committee (cooperative-close path). Standalone ethers (no hardhat
// runtime) so it talks to any EVM RPC.

const { JsonRpcProvider, Wallet, ContractFactory, AbiCoder, keccak256, getBytes, id, parseEther, formatEther } = require('ethers')
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
  // Public RPCs are load-balanced and lag read-after-write; poll dependent state
  // to propagate before the next tx (otherwise gas estimation sees stale state).
  const untilGte = async (fn, want, label, tries = 40) => {
    for (let i = 0; i < tries; i++) { let v = 0n; try { v = BigInt(await fn()) } catch {} if (v >= BigInt(want)) return v; await sleep(1500) }
    throw new Error('timeout waiting for ' + label)
  }
  const untilCode = async (addr, label, tries = 40) => {
    for (let i = 0; i < tries; i++) { const c = await provider.getCode(addr); if (c && c !== '0x') return; await sleep(1500) }
    throw new Error('no code at ' + label)
  }
  const net = await provider.getNetwork()
  const A = new Wallet(KEY, provider) // funded deployer + player A
  const B = Wallet.createRandom().connect(provider) // ephemeral player B
  const txs = {}
  const log = (k, label, tx) => { txs[k] = tx.hash; console.log('  ' + label.padEnd(22) + tx.hash) }

  console.log('\n══════════ P2Poker — live on-chain proof ══════════')
  console.log('network   : ' + net.name + ' (chainId ' + net.chainId + ')')
  console.log('player A  : ' + A.address + '  (' + formatEther(await provider.getBalance(A.address)) + ' ETH)')
  console.log('player B  : ' + B.address + '  (ephemeral)')

  console.log('\n[1] fund B with gas')
  let tx = await A.sendTransaction({ to: B.address, value: parseEther('0.008') }); await tx.wait(); log('fundB', 'fund B', tx)

  console.log('\n[2] deploy MockUSDT + PokerEscrow')
  const usdt = await new ContractFactory(usdtArt.abi, usdtArt.bytecode, A).deploy()
  await usdt.waitForDeployment(); const usdtAddr = await usdt.getAddress()
  console.log('  MockUSDT             ' + usdtAddr)
  const escrowId = id('base-sepolia-demo-' + net.chainId)
  const escrow = await new ContractFactory(escrowArt.abi, escrowArt.bytecode, A).deploy(escrowId, usdtAddr, [A.address, B.address], [], 0)
  await escrow.waitForDeployment(); const escrowAddr = await escrow.getAddress()
  console.log('  PokerEscrow          ' + escrowAddr)
  console.log('  escrowId             ' + escrowId)
  await untilCode(usdtAddr, 'MockUSDT'); await untilCode(escrowAddr, 'PokerEscrow')

  console.log('\n[3] mint test USD₮ to both players (1,000 each)')
  tx = await usdt.connect(A).mint(A.address, U(1000)); await tx.wait(); log('mintA', 'mint A', tx)
  tx = await usdt.connect(B).mint(B.address, U(1000)); await tx.wait(); log('mintB', 'mint B', tx)
  await untilGte(() => usdt.balanceOf(A.address), U(1000), 'A balance')
  await untilGte(() => usdt.balanceOf(B.address), U(1000), 'B balance')

  console.log('\n[4] each deposits a 100 USD₮ bankroll (approve + deposit)')
  tx = await usdt.connect(A).approve(escrowAddr, U(100)); await tx.wait(); log('apprA', 'A approve', tx)
  await untilGte(() => usdt.allowance(A.address, escrowAddr), U(100), 'A allowance')
  tx = await escrow.connect(A).deposit(U(100)); await tx.wait(); log('depA', 'A deposit', tx)
  tx = await usdt.connect(B).approve(escrowAddr, U(100)); await tx.wait(); log('apprB', 'B approve', tx)
  await untilGte(() => usdt.allowance(B.address, escrowAddr), U(100), 'B allowance')
  tx = await escrow.connect(B).deposit(U(100)); await tx.wait(); log('depB', 'B deposit', tx)
  await untilGte(() => escrow.pot(), U(200), 'pot')
  console.log('  pot                  ' + fmt(await escrow.pot()) + ' USD₮')

  console.log('\n[5] settle the NET: A wins 50 → final A=150, B=50 (both co-sign)')
  const payees = [A.address, B.address]
  const balances = [U(150), U(50)]
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address[]', 'uint256[]'], [escrowId, payees, balances]))
  const sigA = await A.signMessage(getBytes(digest))
  const sigB = await B.signMessage(getBytes(digest))
  tx = await escrow.connect(A).cooperativeClose(payees, balances, [sigA, sigB]); await tx.wait(); log('close', 'cooperativeClose', tx)
  await untilGte(async () => (await escrow.settled()) ? 1n : 0n, 1, 'settled flag')
  console.log('  settled              ' + (await escrow.settled()))

  console.log('\n[6] each withdraws their settled net')
  await untilGte(() => escrow.withdrawable(A.address), U(150), 'A withdrawable')
  tx = await escrow.connect(A).withdraw(); await tx.wait(); log('wdA', 'A withdraw', tx)
  await untilGte(() => escrow.withdrawable(B.address), U(50), 'B withdrawable')
  tx = await escrow.connect(B).withdraw(); await tx.wait(); log('wdB', 'B withdraw', tx)
  await untilGte(() => usdt.balanceOf(A.address), U(1050), 'A final balance')

  const balA = await usdt.balanceOf(A.address); const balB = await usdt.balanceOf(B.address)
  console.log('\n[7] final USD₮ balances (started 1,000, deposited 100):')
  console.log('  A  ' + fmt(balA) + '   (1000 - 100 + 150 = 1050 ✓ ' + (balA === U(1050)) + ')')
  console.log('  B  ' + fmt(balB) + '    (1000 - 100 +  50 =  950 ✓ ' + (balB === U(950)) + ')')

  const out = {
    chainId: net.chainId.toString(),
    network: net.name,
    usdt: usdtAddr,
    escrow: escrowAddr,
    escrowId,
    players: { A: A.address, B: B.address },
    txs,
    deployedAt: new Date().toISOString()
  }
  const file = path.join(__dirname, '..', 'live-deployment.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  console.log('\nwrote ' + file)
  console.log('\n══════════ LIVE PROOF OK — real USD₮ settled through the escrow on ' + net.name + ' ══════════\n')
}

main().catch((e) => { console.error('FAILED:', e.shortMessage || e.message); process.exitCode = 1 })
