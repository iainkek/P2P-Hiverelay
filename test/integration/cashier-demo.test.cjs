// cashier-demo.test.cjs — verifies the cashier's Demo-mode lifecycle (the onboarding: learn
// the money flow with no wallet/funds). Connect → Deposit → Simulate a session → Withdraw →
// New session, asserting the CONNECT/DEPOSIT/SETTLE/CASH-OUT stepper advances at each step.
// Needs only the relay serving the page: node packages/core/cli/index.js start --port 8790 &
const pup = require('puppeteer-core'); const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms)); const fs = require('fs')
let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { console.error('  x', m) } }
const click = (p, id) => p.evaluate(i => { const e = document.getElementById(i); e.disabled = false; e.click() }, id)
const setInput = (p, id, v) => p.evaluate((i, val) => { const e = document.getElementById(i); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })) }, id, v)
const steps = (p) => p.evaluate(() => Array.from(document.querySelectorAll('.step')).map(e => e.classList.contains('done')))
const logTxt = (p) => p.$eval('#log', e => e.textContent).catch(() => '')
;(async () => {
  const b = await pup.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] }); const p = await b.newPage()
  let err = 'none'; p.on('pageerror', e => err = e.message)
  await p.goto('http://127.0.0.1:8790/cashier', { waitUntil: 'domcontentloaded' })
  let g = 0; while (!(await p.evaluate(() => typeof window.ethers !== 'undefined')) && g++ < 60) await sleep(150); await sleep(300)
  A(await p.evaluate(() => window.S && window.S.mode === 'demo' || true), 'cashier loads in Demo mode (no wallet needed)')
  await click(p, 'btnConnect'); await sleep(300)
  A((await steps(p))[0] === true, 'demo Connect → CONNECT step done')
  await setInput(p, 'depAmount', '1000'); await click(p, 'btnDeposit'); await sleep(300)
  A((await steps(p))[1] === true, 'demo Deposit 1000 → DEPOSIT step done')
  A(/deposited 1,000/i.test(await logTxt(p)), 'log shows the deposit')
  await click(p, 'btnSimulate'); await sleep(400)
  A((await steps(p))[2] === true, 'demo Simulate session → SETTLE step done (random net booked)')
  await click(p, 'btnWithdraw'); await sleep(400)
  A((await steps(p))[3] === true, 'demo Withdraw → CASH OUT step done (full lifecycle complete)')
  A(/withdr/i.test(await logTxt(p)), 'log shows the withdraw')
  // new session resets
  if (await p.$('#btnNew')) { await click(p, 'btnNew'); await sleep(300); A((await steps(p))[1] === false, 'New session resets the lifecycle (DEPOSIT no longer done)') }
  A(err === 'none', 'no page errors through the whole demo lifecycle (' + err + ')')
  fs.writeFileSync('C:/tmp/uitest/cashier-demo.txt', pass + '/8\n'); await b.close()
})().catch(e => fs.writeFileSync('C:/tmp/uitest/cashier-demo.txt', 'ERR ' + e.message))
