// play-on-fra.mjs — FRA-readiness smoke (Phase: relay integration).
//
// Drives a HiveRelay (default: the FRA test relay) as a CLIENT over its public
// poker HTTP API: creates an EPHEMERAL test table, posts a signed hand to the
// signed log, reads it back, and feeds it to the money reducer — proving a hand
// recorded on the REAL relay produces the settlement the on-chain escrow pays.
//
// It NEVER touches the live poker service's code or config — it only writes a
// throwaway test table (the relay is card-blind; a test table is a few opaque
// signed-log entries). Entries are signed with the relay's own canonicalBytes
// so they validate. The on-chain half (escrow) is proven separately; together
// = the full system with FRA as the substrate.
//
//   node packages/services/builtin/poker/money/fra/play-on-fra.mjs
//   FRA_URL=https://<relay> node .../play-on-fra.mjs   (override target)

import sodium from 'sodium-universal'
import b4a from 'b4a'
import { SignedLog } from '../../signed-log.js'
import { reduce } from '../reducer.js'

const FRA = process.env.FRA_URL || 'https://milkyb-hiverelay-fra.fly.dev'
// FRA gates poker-table creation behind the relay management key
// (Authorization: Bearer <key>). Provide it (operator-only) to run on FRA:
//   FRA_API_KEY=<relay key> node .../play-on-fra.mjs
const API_KEY = process.env.FRA_API_KEY || null
const authHeaders = API_KEY ? { Authorization: 'Bearer ' + API_KEY } : {}
const card = (r, s = 0) => r * 4 + s

function keypair () {
  const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  return { pubHex: b4a.toString(pk, 'hex'), sk }
}

function signEntry (body, sk) {
  const canonical = SignedLog.canonicalBytes(body)
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, canonical, sk)
  return { ...body, signature: b4a.toString(sig, 'hex') }
}

async function post (path, body) {
  const res = await fetch(FRA + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders }, body: JSON.stringify(body) })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
async function get (path) {
  const res = await fetch(FRA + path, { headers: { ...authHeaders } })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

async function main () {
  const table = keypair()
  const alice = keypair()
  const bob = keypair()
  console.log('relay:', FRA)
  console.log('test table:', table.pubHex.slice(0, 16) + '… (ephemeral)')

  let r = await post('/api/poker/tables', { tableKey: table.pubHex, writers: [alice.pubHex, bob.pubHex] })
  console.log('createTable:', r.status, JSON.stringify(r.json).slice(0, 140))
  if (r.status !== 201) throw new Error('createTable failed: ' + r.status)

  // alice authors the canonical hand record; bob acks (2 writers exercised).
  const hand = {
    kind: 'hand',
    handId: 'h1',
    board: [card(7, 0), card(3, 1), card(2, 2), card(0, 3), card(6, 0)],
    contributions: { [alice.pubHex]: 30000000, [bob.pubHex]: 30000000 },
    folded: [],
    reveals: { [alice.pubHex]: [card(12, 0), card(12, 1)], [bob.pubHex]: [card(11, 0), card(11, 1)] }
  }
  const a = signEntry({ tableKey: table.pubHex, writer: alice.pubHex, seq: 0, ts: Date.now(), payload: hand }, alice.sk)
  r = await post(`/api/poker/${table.pubHex}/move`, a)
  console.log('alice hand entry:', r.status, JSON.stringify(r.json))
  const b = signEntry({ tableKey: table.pubHex, writer: bob.pubHex, seq: 0, ts: Date.now(), payload: { kind: 'ack', handId: 'h1' } }, bob.sk)
  r = await post(`/api/poker/${table.pubHex}/move`, b)
  console.log('bob ack entry: ', r.status, JSON.stringify(r.json))

  r = await get(`/api/poker/${table.pubHex}/log?from=0&limit=100`)
  const entries = (r.json && r.json.entries) || []
  console.log('log read back:', r.status, entries.length, 'entries')

  // Reconstruct the session from the signed log and reduce it.
  const handEntries = entries.filter(e => e && e.payload && e.payload.kind === 'hand')
  const session = {
    seats: [alice.pubHex, bob.pubHex],
    hands: handEntries.map(e => ({
      handId: e.payload.handId,
      board: e.payload.board,
      contributions: e.payload.contributions,
      folded: e.payload.folded,
      reveals: e.payload.reveals
    }))
  }
  const reduced = reduce(session)
  console.log('\n=== reducer over FRA signed-log ===')
  console.log('illegal:    ', reduced.illegal)
  if (reduced.illegal) {
    console.error('FAILED: the relay log did not reduce to a legal session — cannot settle.')
    process.exitCode = 1
    return
  }
  console.log('sessionHash:', reduced.sessionHash)
  console.log('balances:   ', { alice: reduced.balances[alice.pubHex], bob: reduced.balances[bob.pubHex] })

  const dep = 100000000 // 100 USD₮ deposits
  console.log('on-chain final balances (100 USD₮ each):', {
    alice: (dep + reduced.balances[alice.pubHex]) / 1e6 + ' USDT',
    bob: (dep + reduced.balances[bob.pubHex]) / 1e6 + ' USDT'
  })
  console.log('\nOK — a hand on the real relay reduces to the settlement the escrow pays.')
}

main().catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1 })
