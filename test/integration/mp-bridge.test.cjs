// mp-bridge.test.cjs — proves the game→cashier net handoff end-to-end: two browsers play a
// real hand, the host's net is bridged to localStorage, and clicking "Settle in the Cashier"
// navigates to /cashier with that exact net preserved across the same-origin navigation (the
// beforeunload guard correctly blocks a RAW goto; the Settle button clears it). The integration
// seam between the trustless game and the on-chain money rail.
// Run: node packages/core/cli/index.js start --port 8790 &  then  node this file.
const fs = require('fs'); const puppeteer = require('puppeteer-core'); const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = 'C:/tmp/uitest/mp-bridge-out.txt'; fs.writeFileSync(OUT, ''); const W = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n')
const sleep = (ms) => new Promise(r => setTimeout(r, ms)); let pass = 0; const A = (c, m) => { if (!c) { W('  x', m); process.exitCode = 1 } else { pass++; W('  ok', m) } }
const setVal = (p, s, v) => p.evaluate((sel, val) => { const e = document.querySelector(sel); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })) }, s, v)
const waitVal = async (p, s, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await p.$eval(s, e => e.value).catch(() => ''); if (v) return v; await sleep(150) } return '' }
const ctrlVis = (p) => p.$eval('#controls', e => getComputedStyle(e).display !== 'none').catch(() => false)
const dis = (p, s) => p.$eval(s, e => e.disabled).catch(() => true)
const handDone = (p) => p.evaluate(() => window.__hand && window.__hand.done).catch(() => false)
const call = async (p) => { if (await ctrlVis(p) && !(await dis(p, '#bCall'))) await p.click('#bCall') }
;(async () => {
  W('start'); const launch = () => puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const bh = await launch(), bj = await launch()
  const open = async (b) => { const p = await b.newPage(); p.on('pageerror', e => W('PAGEERR ' + e.message)); await p.goto('http://127.0.0.1:8790/mp-table', { waitUntil: 'domcontentloaded' }); let g = 0; while (!(await p.evaluate(() => window.__mpReady).catch(() => false)) && g++ < 60) await sleep(150); return p }
  const host = await open(bh), join = await open(bj)
  await host.click('#bHost'); const invite = await waitVal(host, '#inviteOut')
  await join.click('#bJoin'); await sleep(150); await setVal(join, '#inviteIn', invite); await join.click('#acceptInvite')
  const jc = await waitVal(join, '#joinOut'); await setVal(host, '#joinIn', jc); await sleep(150); await host.click('#startHost')
  let g = 0; while (!((await handDone(host)) && (await handDone(join))) && g++ < 320) { await call(host); await call(join); await sleep(450) }
  A(await handDone(host) && await handDone(join), 'a real hand completed')
  const gameNet = await host.evaluate(() => window.__hand.myNet) // the host's net from the actual game
  const bridged = await host.evaluate(() => localStorage.getItem('p2poker.mp.net'))
  W('host game net ' + gameNet + ' · bridged ' + bridged)
  A(parseInt(bridged) === gameNet, 'the game net is written to localStorage (the cashier bridge)')
  // The REAL handoff: click "Settle in the Cashier" (clears the beforeunload guard + navigates)
  await sleep(1600) // between-hands UI renders (toCashier shown)
  A(await host.$eval('#toCashier', e => getComputedStyle(e).display !== 'none').catch(() => false), 'host sees "Settle in the Cashier"')
  await host.evaluate(() => document.getElementById('toCashier').click())
  await host.waitForFunction(() => location.pathname === '/cashier', { timeout: 20000 }).catch(() => {})
  await sleep(700)
  A(/\/cashier$/.test(host.url()), 'clicking Settle navigated to /cashier (' + host.url() + ')')
  const afterNav = await host.evaluate(() => localStorage.getItem('p2poker.mp.net'))
  A(parseInt(afterNav) === gameNet, 'the net SURVIVES the navigation to /cashier (same-origin localStorage)')
  // and the cashier can see it (its Fill-from-net reads this exact key)
  const cashierSees = await host.evaluate(() => { const r = localStorage.getItem('p2poker.mp.net'); return r != null ? parseFloat(r) : NaN })
  A(cashierSees === gameNet, 'the cashier page reads the same net the game produced (end-to-end handoff)')
  await bh.close(); await bj.close(); W(pass + ' passed')
})().catch(e => { W('RUN ERROR ' + e.message); process.exitCode = 1 })
