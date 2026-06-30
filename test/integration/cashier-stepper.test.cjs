// cashier-stepper.test.cjs — verifies the cashier's lifecycle stepper (CONNECT → DEPOSIT →
// SETTLE → CASH OUT) advances accurately as the player drives the real Live flow, via the
// mock EIP-1193 provider + a local 84532 hardhat node. See cashier-live.test.cjs for setup.
const puppeteer = require('puppeteer-core')
const ethers = require('../../packages/services/builtin/poker/money/escrow/node_modules/ethers')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545')
const wallet = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider)
let nextNonce = null
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { console.error('  x', m); process.exitCode = 1 } }
async function ethRpc (method, params) { params = params || []
  if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address]
  if (method === 'personal_sign') return await wallet.signMessage(ethers.getBytes(params[0]))
  if (method === 'eth_sendTransaction') { if (nextNonce === null) nextNonce = await provider.getTransactionCount(wallet.address); const n = nextNonce++; const p = params[0]; const tx = await wallet.sendTransaction({ to: p.to || undefined, data: p.data || undefined, value: p.value ? BigInt(p.value) : 0n, nonce: n }); return tx.hash }
  return await provider.send(method, params) }
const logTxt = (p) => p.$eval('#log', e => e.textContent).catch(() => '')
const waitLog = async (p, re, ms = 90000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(await logTxt(p))) return true; await sleep(500) } return false }
const setInput = (p, id, v) => p.evaluate((i, val) => { const e = document.getElementById(i); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })) }, id, v)
const click = (p, id) => p.evaluate(i => { const e = document.getElementById(i); e.disabled = false; e.click() }, id)
// returns the index of the step marked 'done' up to (e.g. [true,false,false,false])
const steps = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.step')).map(e => e.classList.contains('done')))
const activeStep = (p) => p.evaluate(() => { const a = Array.from(document.querySelectorAll('.step')).findIndex(e => e.classList.contains('active')); return a })
;(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage(); let perr = 'none'; p.on('pageerror', e => perr = e.message)
  await p.exposeFunction('__ethRpc', ethRpc)
  await p.evaluateOnNewDocument(() => { window.ethereum = { isMetaMask: true, request: ({ method, params }) => window.__ethRpc(method, params), on () {}, removeListener () {} } })
  await p.goto('http://127.0.0.1:8790/cashier', { waitUntil: 'domcontentloaded' })
  let g = 0; while (!(await p.evaluate(() => typeof window.ethers !== 'undefined')) && g++ < 60) await sleep(150)
  await click(p, 'btnLive'); await sleep(300)
  A(JSON.stringify(await steps(p)) === JSON.stringify([false, false, false, false]) && await activeStep(p) === 0, 'fresh: no steps done, CONNECT active')
  await click(p, 'btnDeployTest'); await waitLog(p, /test escrow ready/i, 120000); await sleep(500)
  A((await steps(p))[0] === true && await activeStep(p) === 1, 'after connect+deploy: CONNECT done, DEPOSIT active')
  await setInput(p, 'depAmount', '1000'); await click(p, 'btnDeposit'); await waitLog(p, /deposit confirmed/i, 90000); await sleep(500)
  A((await steps(p))[1] === true && await activeStep(p) === 2, 'after deposit: DEPOSIT done, SETTLE active')
  await setInput(p, 'setBalances', '1000'); await click(p, 'btnSign'); await waitLog(p, /signed the agreed/i, 30000)
  await p.evaluate(() => { const s = document.getElementById('mySig').value; const a = document.getElementById('allSigs'); a.value = s; a.dispatchEvent(new Event('input', { bubbles: true })) })
  await click(p, 'btnSubmitClose'); await waitLog(p, /settled on-chain/i, 90000); await sleep(500)
  A((await steps(p))[2] === true && await activeStep(p) === 3, 'after settle: SETTLE done, CASH OUT active')
  await click(p, 'btnWithdraw'); await waitLog(p, /withdraw confirmed/i, 90000); await sleep(500)
  A(JSON.stringify(await steps(p)) === JSON.stringify([true, true, true, true]), 'after withdraw: ALL four steps done')
  A(perr === 'none', 'no page errors (' + perr + ')')
  await b.close()
  console.log('\n' + pass + '/6 — the cashier stepper advances accurately through the whole money flow')
})().catch(e => { console.error('RUN ERROR', e.message); process.exitCode = 1 })
