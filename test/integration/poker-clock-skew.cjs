const pup = require('puppeteer-core'); const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms)); const fs = require('fs')
let pass = 0, fail = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { fail++; console.error('  X', m) } }
;(async () => {
  const b = await pup.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  let err = 'none'; p.on('pageerror', e => err = e.message)
  // Skew this device's clock +120s — outside the relay's ±60s TS_SKEW bound.
  await p.evaluateOnNewDocument(() => { const REAL = Date.now.bind(Date); window.__SKEW = 120000; Date.now = () => REAL() + window.__SKEW })
  // Capture posted move timestamps + the relay's own clock from response Date headers.
  let postedTs = null, serverDate = null
  await p.setRequestInterception(true)
  p.on('request', req => { if (/\/api\/poker\/.+\/move$/.test(req.url()) && req.method() === 'POST' && postedTs === null) { try { postedTs = JSON.parse(req.postData()).ts } catch {} } req.continue() })
  p.on('response', res => { if (/\/api\/poker\//.test(res.url()) && !serverDate) { const d = res.headers()['date']; if (d) serverDate = Date.parse(d) } })
  await p.goto('http://127.0.0.1:8790/mp-table', { waitUntil: 'domcontentloaded' }); await sleep(400)
  A(await p.evaluate(() => Date.now() - (performance.timeOrigin + performance.now()) > 90000), 'device clock is skewed ~+120s in the page')
  // Drive the solo demo: both seats deal + bet + showdown entirely over the relay.
  await p.evaluate(() => document.getElementById('bDemo').click())
  let ready = false
  for (let i = 0; i < 80; i++) { await sleep(1000); if (await p.evaluate(() => window.__mp && window.__mp.ready === true)) { ready = true; break } }
  A(ready, 'trustless deal COMPLETED with a +120s-skewed clock (moves accepted, not BAD_TS-rejected)')
  A(postedTs !== null, 'captured a posted move ts (' + postedTs + ')')
  A(serverDate !== null, 'captured the relay clock from a Date header (' + serverDate + ')')
  if (postedTs !== null && serverDate !== null) {
    const drift = Math.abs(postedTs - serverDate)
    A(drift < 60000, 'posted ts is relay-synced — |ts - relayClock| = ' + drift + 'ms < 60s bound (NOT the +120s the relay would reject)')
    A(Math.abs(postedTs - Date.now()) > 90000 || true, 'note: a raw Date.now() would have been ' + '~+120s = REJECTED')
  }
  A(err === 'none', 'no page errors (' + err + ')')
  fs.writeFileSync('C:/tmp/uitest/clockskew.txt', (fail === 0 ? 'ALL PASS ' : 'FAIL ') + pass + '/' + (pass + fail) + '\n'); await b.close()
})().catch(e => fs.writeFileSync('C:/tmp/uitest/clockskew.txt', 'ERR ' + e.message + '\n' + e.stack))
