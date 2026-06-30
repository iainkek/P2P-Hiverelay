import puppeteer from 'puppeteer-core'
import { reduceMpHand } from '../../packages/services/builtin/poker/mp-reducer.js'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { console.error('  x', m); process.exitCode = 1 } }
const setVal = (p, s, v) => p.evaluate((sel, val) => { const e = document.querySelector(sel); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })) }, s, v)
const waitVal = async (p, s, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await p.$eval(s, e => e.value).catch(() => ''); if (v) return v; await sleep(150) } return '' }
const ctrlVis = (p) => p.$eval('#controls', e => getComputedStyle(e).display !== 'none').catch(() => false)
const dis = (p, s) => p.$eval(s, e => e.disabled).catch(() => true)
const handDone = (p) => p.evaluate(() => window.__hand && window.__hand.done).catch(() => false)
const call = async (p) => { if (await ctrlVis(p) && !(await dis(p, '#bCall'))) await p.click('#bCall') }

async function playHand (cheat) {
  const launch = () => puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const bh = await launch(), bj = await launch()
  const open = async (b) => { const p = await b.newPage(); await p.goto('http://127.0.0.1:8790/mp-table', { waitUntil: 'domcontentloaded' }); let g = 0; while (!(await p.evaluate(() => window.__mpReady).catch(() => false)) && g++ < 60) await sleep(150); await sleep(500); return p }
  const clk = (p, s) => p.evaluate(sel => document.querySelector(sel).click(), s)
  const host = await open(bh), join = await open(bj)
  if (cheat) await join.evaluate(() => { window.__cheatShuffle = true })
  await clk(host, '#bHost'); const invite = await waitVal(host, '#inviteOut')
  await clk(join, '#bJoin'); await sleep(150); await setVal(join, '#inviteIn', invite); await clk(join, '#acceptInvite')
  const joinCode = await waitVal(join, '#joinOut')
  await setVal(host, '#joinIn', joinCode); await sleep(150); await clk(host, '#startHost')
  let g = 0; while (!(await handDone(host)) && g++ < 340) { await call(host); await call(join); await sleep(450) }
  const info = await host.evaluate(() => window.__sessionInfo)
  const hostHand = await host.evaluate(() => window.__hand)
  const joinHand = await join.evaluate(() => window.__hand).catch(() => null)
  const log = await host.evaluate(async (key) => { const r = await fetch('/api/poker/' + key + '/log?from=0&limit=500'); const j = await r.json(); return j.entries || [] }, info.tableKey)
  await bh.close(); await bj.close()
  return { info, hostHand, joinHand, log }
}

;(async () => {
  // --- honest hand: the reducer must reproduce the client's net exactly ---
  console.log('honest hand…')
  const h = await playHand(false)
  const [W0, W1] = h.info.writers
  const r = reduceMpHand(h.log, h.info.writers, h.info.config)
  A(r.cheater === null, 'reducer finds NO cheat on honest play')
  A(r.net[W0] === h.hostHand.myNet, 'reducer net for host matches the client (' + r.net[W0] + ' == ' + h.hostHand.myNet + ')')
  if (h.joinHand) A(r.net[W1] === h.joinHand.myNet, 'reducer net for joiner matches the client (' + r.net[W1] + ' == ' + h.joinHand.myNet + ')')
  A((r.net[W0] + r.net[W1]) === 0, 'reducer nets are zero-sum (' + r.net[W0] + '/' + r.net[W1] + ')')
  A(r.balances[W0] === 1000 + h.hostHand.myNet, 'reducer balance = buy-in + net (settles on-chain)')

  // --- cheat hand: the reducer must catch the cheater and award the honest seat ---
  console.log('cheat hand (joiner tampers its shuffle)…')
  const c = await playHand(true)
  const [C0, C1] = c.info.writers // C0 = host (honest), C1 = joiner (cheater)
  const rc = reduceMpHand(c.log, c.info.writers, c.info.config)
  A(rc.cheater === C1, 'reducer independently identifies the cheater = the joiner')
  A(rc.net[C0] > 0 && rc.net[C1] < 0, 'reducer awards the honest host, penalizes the cheater (' + rc.net[C0] + '/' + rc.net[C1] + ')')
  A((rc.net[C0] + rc.net[C1]) === 0, 'cheat-forfeit nets are zero-sum')
  A(rc.net[C0] === c.hostHand.myNet, 'reducer agrees with the honest host’s own claim (' + rc.net[C0] + ')')
  console.log('\n' + pass + ' passed — dispute reducer reproduces the client + catches cheats from the log alone')
})().catch(e => { console.error('RUN ERROR', e.message, e.stack); process.exitCode = 1 })
