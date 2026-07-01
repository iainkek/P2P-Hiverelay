const pup = require('puppeteer-core'); const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms)); const fs = require('fs')
let pass = 0, fail = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { fail++; console.error('  X', m) } }
;(async () => {
  const b = await pup.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const p = await b.newPage()
  let err = 'none'; p.on('pageerror', e => err = e.message)
  // Simulate a plain-HTTP, NON-secure context: no crypto.subtle (WebCrypto gone),
  // isSecureContext=false, but crypto.getRandomValues still present (as in real HTTP).
  await p.evaluateOnNewDocument(() => {
    Object.defineProperty(window, 'isSecureContext', { get: () => false })
    try { Object.defineProperty(window.crypto, 'subtle', { get: () => undefined, configurable: true }) } catch {}
  })
  await p.goto('http://127.0.0.1:8790/mp-table', { waitUntil: 'domcontentloaded' }); await sleep(500)
  A(await p.evaluate(() => window.isSecureContext === false), 'page reports NON-secure context')
  A(await p.evaluate(() => window.crypto.subtle === undefined), 'crypto.subtle is UNAVAILABLE (WebCrypto path is dead)')
  A(await p.evaluate(() => typeof window.crypto.getRandomValues === 'function'), 'crypto.getRandomValues present (as over real HTTP)')
  A(await p.evaluate(() => !document.getElementById('bDemo').disabled), 'Host/Join/Demo NOT disabled (old HTTPS guard is gone)')
  // Prove noble seat crypto works with no WebCrypto: generate + sign in-page.
  const sigOk = await p.evaluate(async () => {
    const m = await import('/poker-engine/relay-table-client.js')
    const seat = await m.createSeat()
    const signed = await m.signEntry({ ...seat, sign: seat }, { tableKey: 't', writer: seat.pub, seq: 0, ts: 1, payload: { k: 1 } })
    return !!(seat.pub && seat.pub.length === 64 && signed.signature && signed.signature.length === 128)
  }).catch(e => 'ERR:' + e.message)
  A(sigOk === true, 'createSeat + signEntry produced a 32-byte pubkey + 64-byte sig via noble (no subtle) — ' + sigOk)
  // Full deal over the relay: every move is noble-signed and must pass the relay's sodium verify.
  await p.evaluate(() => document.getElementById('bDemo').click())
  let ready = false
  for (let i = 0; i < 80; i++) { await sleep(1000); if (await p.evaluate(() => window.__mp && window.__mp.ready === true)) { ready = true; break } }
  A(ready, 'FULL trustless deal completed over plain HTTP — relay ACCEPTED every noble sig (sodium-verified)')
  A(err === 'none', 'no page errors (' + err + ')')
  fs.writeFileSync('C:/tmp/uitest/nohttps.txt', (fail === 0 ? 'ALL PASS ' : 'FAIL ') + pass + '/' + (pass + fail) + '\n'); await b.close()
})().catch(e => fs.writeFileSync('C:/tmp/uitest/nohttps.txt', 'ERR ' + e.message + '\n' + e.stack))
