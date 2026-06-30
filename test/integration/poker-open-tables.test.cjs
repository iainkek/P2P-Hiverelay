// poker-open-tables.test.cjs — verifies the openPokerTables deployment fix. On a hosted
// (keyed) relay the browser client has no API key, so POST /api/poker/tables would 401 and
// block remote players from hosting. The opt-in flag allows player-hosted tables without the
// key (rate-limited + maxTables-capped), while general auth routes stay gated. Run twice:
//   HIVERELAY_API_KEY=k node ...start --port 8790 &              then node this default
//   HIVERELAY_API_KEY=k HIVERELAY_OPEN_POKER_TABLES=1 ...start & then node this flag
const http = require('http')
const req = (method, path, body, auth) => new Promise(r => {
  const data = body ? JSON.stringify(body) : null
  const headers = { 'Content-Type': 'application/json' }; if (auth) headers.Authorization = 'Bearer ' + auth
  const rq = http.request({ host: '127.0.0.1', port: 8790, path, method, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => r({ status: res.statusCode, body: b })) })
  rq.on('error', () => r({ status: 0 })); if (data) rq.write(data); rq.end()
})
const tk = 'a'.repeat(64), w = ['b'.repeat(64), 'c'.repeat(64)]
;(async () => {
  const mode = process.argv[2]
  let pass = 0; const A = (c, m) => { if (c) { pass++; console.log('  ok', m) } else console.error('  x', m) }
  if (mode === 'default') {
    const t = await req('POST', '/api/poker/tables', { tableKey: tk, writers: w }) // no auth
    A(t.status === 401, 'DEFAULT (keyed relay): createTable without API key → 401 (the deployment blocker)')
    const u = await req('GET', '/api/poker/usage')
    A(u.status === 401, 'DEFAULT: a general auth route also 401s without the key')
  } else {
    const t = await req('POST', '/api/poker/tables', { tableKey: tk, writers: w }) // no auth
    A(t.status !== 401, 'FLAG ON (keyed relay): createTable without API key is NOT 401 — remote players can host (status ' + t.status + ')')
    const u = await req('GET', '/api/poker/usage')
    A(u.status === 401, 'FLAG ON: a GENERAL auth route still 401s — the flag is poker-table-specific, general auth intact')
  }
  console.log(pass + ' ok (' + mode + ')')
})()
