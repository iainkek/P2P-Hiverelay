// poker-rate-limit.test.cjs — verifies poker GAME routes (/api/poker/<table>/{move,log,events})
// get the higher POKER_RATE_LIMIT_MAX (600/min) cap so normal high-frequency play isn't
// throttled by the general 60/min (1/s) limit, while general routes keep the strict cap.
// Run against a relay: node packages/core/cli/index.js start --port 8790 &  then node this.
const http = require('http')
const get = (path) => new Promise(r => { http.get({ host: '127.0.0.1', port: 8790, path }, res => { res.resume(); r(res.statusCode) }).on('error', () => r(0)) })
;(async () => {
  let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else console.error('  x', m) }
  // 120 rapid hits to a poker GAME route (log) — under the 600 poker cap → no 429
  let log429 = 0
  for (let i = 0; i < 120; i++) { const s = await get('/api/poker/sometablekey/log?from=0&limit=1'); if (s === 429) log429++ }
  A(log429 === 0, '120 rapid poker /log requests: NO 429 (poker cap 600 not hit) — was 1/s before')
  // 90 rapid hits to a GENERAL route (poker /tables list) — general 60/min cap → 429 after 60
  let tbl429 = 0
  for (let i = 0; i < 90; i++) { const s = await get('/api/poker/tables'); if (s === 429) tbl429++ }
  A(tbl429 > 0 && tbl429 >= 20, 'general /tables route still hits the 60/min cap (' + tbl429 + ' of 90 got 429) — general limit intact')
  console.log('\n' + pass + '/2 — poker game routes get the higher cap; general routes keep the 1/s limit')
})().catch(e => console.error('ERR', e.message))
