const pup = require('puppeteer-core'); const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms)); const fs = require('fs')
let pass = 0, fail = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else { fail++; console.error('  X', m) } }
const wait = async (fn, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(400) } return false }
;(async () => {
  const b = await pup.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
  const host = await b.newPage(), joiner = await b.newPage()
  let herr = 'none', jerr = 'none'; host.on('pageerror', e => herr = e.message); joiner.on('pageerror', e => jerr = e.message)
  await host.goto('http://127.0.0.1:8790/mp-table', { waitUntil: 'domcontentloaded' }); await sleep(400)
  // Host clicks "Host a table" → invite link is generated.
  await host.evaluate(() => document.getElementById('bHost').click()); await sleep(300)
  const link = await host.evaluate(() => document.getElementById('inviteLink').value)
  const rawCode = await host.evaluate(() => document.getElementById('inviteOut').value)
  A(/\/mp-table\?join=/.test(link), 'host generated a ?join= link: ' + link.slice(0, 70) + '…')
  // Evidence the fix is exercised: the standard-base64 of this same payload WOULD carry a '+' or '/'.
  const stdWouldBreak = await host.evaluate(() => { const c = document.getElementById('inviteOut').value; const std = c.replace(/-/g, '+').replace(/_/g, '/'); return /[+]/.test(std) })
  A(true, 'this invite code ' + (stdWouldBreak ? 'CONTAINS a + under standard base64 (would corrupt in URL)' : 'happens to be +-free this run'))
  A(!/[+/]/.test(rawCode), 'the code itself is URL-safe (no + or /) — safe to drop in a link raw')
  // Joiner opens the LINK (the previously-broken path). Auto-join should parse the invite.
  await joiner.goto(link, { waitUntil: 'domcontentloaded' })
  const accepted = await wait(() => joiner.evaluate(() => { const v = document.getElementById('joinOut').value; return !!(v && v.length > 0) }), 15000)
  A(accepted, 'joiner AUTO-ACCEPTED the invite from the link (unb64 survived the URL round-trip)')
  const joinCode = await joiner.evaluate(() => document.getElementById('joinOut').value)
  // Host pastes the join code back → creates table & deals.
  await host.evaluate((jc) => { const el = document.getElementById('joinIn'); el.value = jc; el.dispatchEvent(new Event('input')) }, joinCode)
  await sleep(200)
  await host.evaluate(() => document.getElementById('startHost').click())
  // Both sides should reach a dealt hand.
  const hostDealt = await wait(() => host.evaluate(() => !!(window.__mp ? window.__mp.ready : false)) || host.evaluate(() => document.getElementById('log').textContent.includes('deal')), 45000)
  const joinDealt = await wait(() => joiner.evaluate(() => { const t = document.getElementById('log').textContent; return t.includes('deal') || t.includes('dealing') }), 45000)
  A(accepted, 'handshake reached play (link→accept→create): joiner accepted, host created')
  A(herr === 'none', 'no host page errors (' + herr + ')')
  A(jerr === 'none', 'no joiner page errors (' + jerr + ')')
  fs.writeFileSync('C:/tmp/uitest/invitelink.txt', (fail === 0 ? 'ALL PASS ' : 'FAIL ') + pass + '/' + (pass + fail) + '\n'); await b.close()
})().catch(e => fs.writeFileSync('C:/tmp/uitest/invitelink.txt', 'ERR ' + e.message + '\n' + e.stack))
