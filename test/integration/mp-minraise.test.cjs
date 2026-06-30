// mp-minraise.test.cjs — exercises a MIN-raise (not all-in) through the mp-table UI: the
// host drags the raise slider to its minimum (a real partial raise above the call), the
// joiner calls, and the hand settles zero-sum. Complements the all-in raise coverage.
// Run: node packages/core/cli/index.js start --port 8790 &  then  node this file.
const fs = require('fs'); const puppeteer = require('puppeteer-core')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const OUT = 'C:/tmp/uitest/mp-minraise-out.txt'; fs.writeFileSync(OUT, '')
const W = (...a) => fs.appendFileSync(OUT, a.join(' ') + '\n')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0; const A = (c, m) => { if (!c) { W('  x', m); process.exitCode = 1 } else { pass++; W('  ok', m) } }
const setVal = (p, s, v) => p.evaluate((sel, val) => { const e = document.querySelector(sel); e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })) }, s, v)
const waitVal = async (p, s, ms = 9000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await p.$eval(s, e => e.value).catch(() => ''); if (v) return v; await sleep(150) } return '' }
const ctrlVis = (p) => p.$eval('#controls', e => getComputedStyle(e).display !== 'none').catch(() => false)
const dis = (p, s) => p.$eval(s, e => e.disabled).catch(() => true)
const handDone = (p) => p.evaluate(() => window.__hand && window.__hand.done).catch(() => false)
let hostRaised = false, sliderInfo = ''
const hostAct = async (p) => {
  if (!(await ctrlVis(p))) return
  if (!hostRaised && !(await dis(p, '#bRaise'))) {
    // set the slider to its MINIMUM (a min-raise, NOT all-in)
    const info = await p.evaluate(() => { const s = document.getElementById('raiseSlider'); s.value = s.min; s.dispatchEvent(new Event('input', { bubbles: true })); return { min: s.min, max: s.max, amt: document.getElementById('raiseAmt').textContent } })
    sliderInfo = JSON.stringify(info)
    if (info.min !== info.max) W('  min-raise (' + info.min + ') is below all-in (' + info.max + ') — a real partial raise')
    await p.click('#bRaise'); hostRaised = true
  } else if (!(await dis(p, '#bCall'))) await p.click('#bCall')
}
const joinAct = async (p) => { if (await ctrlVis(p) && !(await dis(p, '#bCall'))) await p.click('#bCall') }
;(async () => {
  W('start'); const launch = () => puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const bh = await launch(), bj = await launch()
  const open = async (b) => { const p = await b.newPage(); p.on('pageerror', e => W('PAGEERR ' + e.message)); await p.goto('http://127.0.0.1:8790/mp-table', { waitUntil: 'domcontentloaded' }); let g = 0; while (!(await p.evaluate(() => window.__mpReady).catch(() => false)) && g++ < 60) await sleep(150); return p }
  const host = await open(bh), join = await open(bj)
  await host.click('#bHost'); const invite = await waitVal(host, '#inviteOut'); A(invite.length > 0, 'invite produced')
  await join.click('#bJoin'); await sleep(150); await setVal(join, '#inviteIn', invite); await join.click('#acceptInvite')
  const joinCode = await waitVal(join, '#joinOut'); A(joinCode.length > 0, 'join code produced')
  await setVal(host, '#joinIn', joinCode); await sleep(150); await host.click('#startHost')
  W('playing — host MIN-raises (slider at min), joiner calls…')
  let g = 0
  while (!((await handDone(host)) && (await handDone(join))) && g++ < 320) { await hostAct(host); await joinAct(join); await sleep(450) }
  const hH = await host.evaluate(() => window.__hand), jH = await join.evaluate(() => window.__hand)
  W('HOST pot ' + (hH && hH.pot) + ' net ' + (hH && hH.myNet) + ' · slider ' + sliderInfo)
  A(hH && hH.done && jH && jH.done, 'hand resolved after a min-raise (no stall)')
  if (hH && jH && hH.done && jH.done) {
    A(hostRaised, 'host actually min-raised via the slider')
    A(hH.pot === jH.pot, 'both agree on the pot')
    A(hH.myNet + jH.myNet === 0, 'nets zero-sum after the min-raise (' + hH.myNet + '/' + jH.myNet + ')')
  }
  await bh.close(); await bj.close(); W(pass + ' passed')
})().catch(e => { W('RUN ERROR ' + e.message); process.exitCode = 1 })
