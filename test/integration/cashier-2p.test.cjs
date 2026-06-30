// cashier-2p.test.cjs — end-to-end verification of the REAL 2-player shared-escrow
// settlement through the cashier UI, using two mock EIP-1193 wallets (hardhat accts 0/1)
// + a local hardhat node at chainId 84532. A deploys a shared escrow naming B; both
// deposit the buy-in; both co-sign the agreed split; A submits cooperativeClose; both
// withdraw their net. See cashier-live.test.cjs for the hardhat/relay setup steps.
const puppeteer = require('puppeteer-core')
const ethers = require('../../packages/services/builtin/poker/money/escrow/node_modules/ethers')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const KEY0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' // hardhat acct 0 (A=host)
const KEY1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' // hardhat acct 1 (B=joiner)
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545')
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { console.error('  x', m); process.exitCode = 1 } }
function rpcFor (wallet) { let nextNonce = null
  return async function (method, params) { params = params || []
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address]
    if (method === 'personal_sign') return await wallet.signMessage(ethers.getBytes(params[0]))
    if (method === 'eth_sendTransaction') { if (nextNonce === null) nextNonce = await provider.getTransactionCount(wallet.address); const n = nextNonce++; const p = params[0]; const tx = await wallet.sendTransaction({ to: p.to || undefined, data: p.data || undefined, value: p.value ? BigInt(p.value) : 0n, nonce: n }); return tx.hash }
    return await provider.send(method, params) } }
const logTxt = (p) => p.$eval('#log', e => e.textContent).catch(() => '')
const waitLog = async (p, re, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await logTxt(p))) return true; await sleep(500) } return false }
const setInput = (p, id, v) => p.evaluate((i, val) => { const e = document.getElementById(i); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })) }, id, v)
const click = (p, id) => p.evaluate(i => { const e = document.getElementById(i); e.disabled = false; e.click() }, id)
const U = (n) => BigInt(n) * 10n ** 6n
;(async () => {
  const wA = new ethers.Wallet(KEY0, provider), wB = new ethers.Wallet(KEY1, provider)
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const mk = async (wallet) => { const p = await b.newPage(); p.on('pageerror', e => console.log('PAGEERR', e.message)); await p.exposeFunction('__ethRpc', rpcFor(wallet)); await p.evaluateOnNewDocument(() => { window.ethereum = { isMetaMask: true, request: ({ method, params }) => window.__ethRpc(method, params), on () {}, removeListener () {} } }); await p.goto('http://127.0.0.1:8790/cashier', { waitUntil: 'domcontentloaded' }); let g = 0; while (!(await p.evaluate(() => typeof window.ethers !== 'undefined')) && g++ < 60) await sleep(150); return p }
  const pA = await mk(wA), pB = await mk(wB)
  const payees = wA.address + ',' + wB.address // [A, B]
  // 1) A deploys a SHARED escrow naming B, then deposits 1000
  await click(pA, 'btnLive'); await sleep(200); await setInput(pA, 'cfgOpponent', wB.address)
  await click(pA, 'btnDeployTest')
  A(await waitLog(pA, /shared escrow ready/i, 120000), 'A: deployed a SHARED 2-seat escrow naming B')
  const tokenAddr = await pA.$eval('#cfgToken', e => e.value), escrowAddr = await pA.$eval('#cfgEscrow', e => e.value)
  await setInput(pA, 'depAmount', '1000'); await click(pA, 'btnDeposit')
  A(await waitLog(pA, /deposit confirmed/i, 90000), 'A: deposited 1000 into the shared escrow')
  // 2) B binds to the same escrow, faucets, deposits 1000
  await click(pB, 'btnLive'); await sleep(200)
  await setInput(pB, 'cfgEscrow', escrowAddr); await setInput(pB, 'cfgToken', tokenAddr)
  await click(pB, 'btnFaucet')
  A(await waitLog(pB, /USD₮ minted/i, 90000), 'B: faucet minted 1000 USD₮')
  await setInput(pB, 'depAmount', '1000'); await click(pB, 'btnDeposit')
  A(await waitLog(pB, /deposit confirmed/i, 90000), 'B: deposited 1000 into the same escrow')
  const tok = new ethers.Contract(tokenAddr, ['function balanceOf(address) view returns (uint256)'], provider)
  A((await tok.balanceOf(escrowAddr)) === U(2000), 'on-chain: shared escrow holds 2000 (both buy-ins)')
  // 3) Both sign the agreed split A:1300 / B:700 (A won 300)
  for (const p of [pA, pB]) { await setInput(p, 'setPayees', payees); await setInput(p, 'setBalances', '1300,700'); await click(p, 'btnSign') }
  A(await waitLog(pA, /signed the agreed result/i, 30000) && await waitLog(pB, /signed the agreed result/i, 30000), 'both seats signed the SAME agreed balances [1300,700]')
  const sigA = await pA.$eval('#mySig', e => e.value), sigB = await pB.$eval('#mySig', e => e.value)
  // 4) A submits the cooperative close with both signatures
  await pA.evaluate((sa, sb) => { const a = document.getElementById('allSigs'); a.value = sa + '\n' + sb; a.dispatchEvent(new Event('input', { bubbles: true })) }, sigA, sigB)
  await click(pA, 'btnSubmitClose')
  A(await waitLog(pA, /settled on-chain/i, 90000), 'A: submitted cooperativeClose([A,B],[1300,700],[sigA,sigB])')
  // 5) both withdraw their split
  await click(pA, 'btnWithdraw'); await click(pB, 'btnWithdraw')
  A(await waitLog(pA, /withdraw confirmed/i, 90000) && await waitLog(pB, /withdraw confirmed/i, 90000), 'both seats withdrew')
  A((await tok.balanceOf(wA.address)) === U(1300), 'on-chain: A (winner) wallet = 1300 (buy-in + 300 net)')
  A((await tok.balanceOf(wB.address)) === U(700), 'on-chain: B (loser) wallet = 700 (buy-in − 300 net)')
  A((await tok.balanceOf(escrowAddr)) === 0n, 'on-chain: shared escrow fully drained — conservation held')
  await b.close()
  console.log('\n' + pass + '/11 — real 2-player shared-escrow settlement works end-to-end through the cashier UI')
})().catch(e => { console.error('RUN ERROR', e.message); process.exitCode = 1 })
