// dispute-close.test.cjs — proves the escrow's dispute-settlement recourse end-to-end on a
// local EVM: an escrow deployed WITH a committee → the committee attests the reducer's
// balances (B wins because A cheated) → disputeClose → the honest player withdraws WITHOUT
// the cheater's cooperation. Also asserts a non-committee signature is rejected (NO_QUORUM).
// Run: cd packages/services/builtin/poker/money/escrow && npx hardhat node &  then  node this file.
// Prove the dispute-settlement path end-to-end: an escrow WITH a committee → the reducer's
// balances (B wins because A cheated) → a committee signature → disputeClose → withdraw.
const E = require('path').resolve(__dirname,'../../packages/services/builtin/poker/money/escrow')
const M = require('path').resolve(__dirname,'../../packages/services/builtin/poker/money')
const { JsonRpcProvider, Wallet, ContractFactory, Contract, NonceManager, id, getBytes, parseEther, AbiCoder, keccak256 } = require(E + '/node_modules/ethers')
const art = require(M + '/poker-artifacts.json')
const U = (n) => BigInt(n) * 1_000_000n
const HH = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ERC = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)']
let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else console.error('  x', m) }
;(async () => {
  const pr = new JsonRpcProvider('http://127.0.0.1:8545')
  const a = new NonceManager(new Wallet(HH, pr))           // A (host, will "cheat")
  const bW = Wallet.createRandom().connect(pr), b = new NonceManager(bW) // B (honest)
  const cW = Wallet.createRandom()                          // C = the relay committee (offline signer)
  const aA = await new Wallet(HH).getAddress(), bA = bW.address, cA = cW.address
  await (await a.sendTransaction({ to: bA, value: parseEther('1') })).wait()
  const BUYIN = 1000
  const usdt = await new ContractFactory(art.usdt.abi, art.usdt.bytecode, a).deploy(); await usdt.waitForDeployment(); const tA = await usdt.getAddress()
  const eid = id('p2poker-dispute')
  // deploy WITH a committee: [C], threshold 1 → disputeClose ENABLED
  const esc = await new ContractFactory(art.escrow.abi, art.escrow.bytecode, a).deploy(eid, tA, [aA, bA], [cA], 1)
  await esc.waitForDeployment(); const eA = await esc.getAddress()
  A((await esc.committeeThreshold()) === 1n, 'escrow deployed WITH a committee (threshold 1) → disputeClose enabled')
  const ta = new Contract(tA, ERC, a), tb = new Contract(tA, ERC, b)
  await (await ta.mint(aA, U(BUYIN))).wait(); await (await tb.mint(bA, U(BUYIN))).wait()
  await (await ta.approve(eA, U(BUYIN))).wait(); await (await esc.connect(a).deposit(U(BUYIN))).wait()
  await (await tb.approve(eA, U(BUYIN))).wait(); await (await esc.connect(b).deposit(U(BUYIN))).wait()
  A((await esc.pot()) === U(2 * BUYIN), 'both deposited the buy-in → pot 2000')
  // A refuses to co-sign (or cheated) → the committee runs the reducer. Its verdict: B wins
  // (A forfeits). balances conserve to the pot. These are exactly reduceMpHand's balances ×1e6.
  const payees = [aA, bA], balances = [U(700), U(1300)] // A 700 (−300), B 1300 (+300)
  const sessionHash = id('table-log-hash'), epoch = 1n
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'address[]', 'uint256[]', 'uint256'], [eid, sessionHash, payees, balances, epoch]))
  const sigC = await cW.signMessage(getBytes(digest)) // the committee attests off-chain
  A(balances[0] + balances[1] === U(2 * BUYIN), 'committee balances conserve to the pot')
  // honest player B submits the dispute close with the committee attestation
  await (await esc.connect(b).disputeClose(sessionHash, epoch, payees, balances, [sigC])).wait()
  A(await esc.settled(), 'disputeClose settled the escrow via the committee quorum')
  await (await esc.connect(a).withdraw()).wait(); await (await esc.connect(b).withdraw()).wait()
  A((await ta.balanceOf(aA)) === U(700), 'A (cheater) withdrew only 700 — penalized')
  A((await tb.balanceOf(bA)) === U(1300), 'B (honest) withdrew 1300 — CLAIMED the win without A’s cooperation')
  A((await ta.balanceOf(eA)) === 0n, 'escrow drained — dispute recourse settles end to end')
  // a forged sig from a non-committee key must NOT pass quorum
  const esc2 = await new ContractFactory(art.escrow.abi, art.escrow.bytecode, a).deploy(id('p2p-d2'), tA, [aA, bA], [cA], 1); await esc2.waitForDeployment()
  const dg2 = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'address[]', 'uint256[]', 'uint256'], [id('p2p-d2'), sessionHash, payees, [0n, 0n], epoch]))
  let rejected = false
  try { await (await esc2.connect(b).disputeClose(sessionHash, epoch, payees, [0n, 0n], [await bW.signMessage(getBytes(dg2))])).wait() } catch { rejected = true }
  A(rejected, 'a non-committee signature is rejected (NO_QUORUM) — only the real committee can attest')
  console.log('\n' + pass + '/8 — dispute-settlement recourse works on-chain (committee attests → honest claim)')
  process.exitCode = pass === 8 ? 0 : 1
})().catch(e => { console.error('ERR', e.shortMessage || e.message); process.exitCode = 1 })
