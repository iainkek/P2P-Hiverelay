// cashier-live.test.cjs — end-to-end verification of the cashier's LIVE on-chain flow
// through the real UI, using a mock EIP-1193 provider (window.ethereum) backed by an
// ethers Wallet + a local hardhat node. Proves deploy → faucet → deposit → sign →
// cooperativeClose → withdraw all work via the actual cashier buttons.
//
// Setup (from repo root):
//   1. cd packages/services/builtin/poker/money/escrow
//      printf "require('@nomicfoundation/hardhat-ethers')\nmodule.exports={solidity:{version:'0.8.24',settings:{optimizer:{enabled:true,runs:200}}},networks:{hardhat:{chainId:84532}}}\n" > hh84532.config.cjs
//      npx hardhat node --config hh84532.config.cjs &   # node MUST report chainId 84532 (the cashier enforces Base Sepolia)
//   2. node packages/core/cli/index.js start --port 8790 &   # serves /cashier + /poker-engine
//   3. node test/integration/cashier-live.test.cjs
const puppeteer = require('puppeteer-core')
const ethers = require('../../packages/services/builtin/poker/money/escrow/node_modules/ethers')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const HH_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545')
const wallet = new ethers.Wallet(HH_KEY, provider)
let nextNonce = null
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { console.error('  x', m); process.exitCode = 1 } }
async function ethRpc (method, params) {
  params = params || []
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address]
  if (method === 'personal_sign') return await wallet.signMessage(ethers.getBytes(params[0]))
  if (method === 'eth_sendTransaction') { if (nextNonce === null) nextNonce = await provider.getTransactionCount(wallet.address); const nonce = nextNonce++; const p = params[0]; const tx = await wallet.sendTransaction({ to: p.to || undefined, data: p.data || undefined, value: p.value ? BigInt(p.value) : 0n, nonce }); return tx.hash }
  return await provider.send(method, params)
}
const logTxt = (p) => p.$eval('#log', e => e.textContent).catch(() => '')
const waitLog = async (p, re, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await logTxt(p))) return true; await sleep(500) } return false }
const setInput = (p, id, v) => p.evaluate((i, val) => { const e = document.getElementById(i); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })) }, id, v)
const forceClick = (p, id) => p.evaluate(i => { const e = document.getElementById(i); e.disabled = false; e.click() }, id)
;(async () => {
  const usdt = ['function balanceOf(address) view returns (uint256)']
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage(); let perr = 'none'; p.on('pageerror', e => perr = e.message)
  await p.exposeFunction('__ethRpc', ethRpc)
  await p.evaluateOnNewDocument(() => { window.ethereum = { isMetaMask: true, request: ({ method, params }) => window.__ethRpc(method, params), on () {}, removeListener () {} } })
  await p.goto('http://127.0.0.1:8790/cashier', { waitUntil: 'domcontentloaded' })
  let g = 0; while (!(await p.evaluate(() => typeof window.ethers !== 'undefined')) && g++ < 60) await sleep(150)
  await forceClick(p, 'btnLive'); await sleep(300)
  await forceClick(p, 'btnDeployTest')
  A(await waitLog(p, /test escrow ready/i, 120000), 'DEPLOY: real ContractFactory deployed USDT+escrow, minted 1000, connected — via the cashier UI')
  const tokenAddr = await p.$eval('#cfgToken', e => e.value).catch(() => '')
  const escrowAddr = await p.$eval('#cfgEscrow', e => e.value).catch(() => '')
  const tok = new ethers.Contract(tokenAddr, usdt, provider)
  A((await tok.balanceOf(wallet.address)) === 1000n * 10n ** 6n, 'on-chain: wallet holds 1,000 USD₮ after the faucet/mint')
  await setInput(p, 'depAmount', '1000'); await forceClick(p, 'btnDeposit')
  A(await waitLog(p, /deposit confirmed/i, 90000), 'DEPOSIT: approve + escrow.deposit(1000) mined via the UI')
  A((await tok.balanceOf(escrowAddr)) === 1000n * 10n ** 6n, 'on-chain: escrow now holds the 1,000 deposit')
  await setInput(p, 'setBalances', '1000'); await forceClick(p, 'btnSign')
  A(await waitLog(p, /signed the agreed result/i, 30000), 'SIGN: produced an EIP-191 settlement signature in-page')
  await p.evaluate(() => { const s = document.getElementById('mySig').value; const a = document.getElementById('allSigs'); a.value = s; a.dispatchEvent(new Event('input', { bubbles: true })) })
  await forceClick(p, 'btnSubmitClose')
  A(await waitLog(p, /settled on-chain/i, 90000), 'SETTLE: cooperativeClose([me],[1000],[sig]) mined via the UI')
  await forceClick(p, 'btnWithdraw')
  A(await waitLog(p, /withdraw confirmed/i, 90000), 'WITHDRAW: escrow.withdraw() mined via the UI')
  A((await tok.balanceOf(escrowAddr)) === 0n, 'on-chain: escrow fully drained after withdraw')
  A((await tok.balanceOf(wallet.address)) === 1000n * 10n ** 6n, 'on-chain: wallet whole again (deposited 1000 → withdrew 1000)')
  A(perr === 'none', 'no page errors during the whole on-chain flow (' + perr + ')')
  await b.close()
  console.log('\n' + pass + '/10 — the cashier Live money rail works end-to-end through the real UI')
})().catch(e => { console.error('RUN ERROR', e.message); process.exitCode = 1 })
