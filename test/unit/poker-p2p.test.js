// test/unit/poker-p2p.test.js
//
// Proves the poker app is reachable over the P2P services-RPC + pubsub path
// (the no-HTTP transport), without changing any HTTP/WS behaviour:
//   1. PokerApp capability methods accept the services-RPC object form
//      (`method(params, ctx)`) AS WELL AS the existing positional form.
//   2. The router auto-registers poker.* as PUBLIC routes, so an unauthenticated
//      remote peer can dispatch them (mirrors the no-auth HTTP surface; SignedLog
//      still enforces writer-allowlist + signature + seq + ts).
//   3. Each successful append fans out to the global AND per-table pubsub topics
//      (the no-HTTP equivalent of the WS /events feed).

import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { Router } from 'p2p-hiverelay/core/router/index.js'
import { PokerApp, SignedLog } from '../../packages/services/builtin/poker/index.js'

function makeKeyPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { secretKey, pubHex: b4a.toString(publicKey, 'hex') }
}

function signEntry (kp, body) {
  const canonical = SignedLog.canonicalBytes(body)
  const sig = b4a.alloc(64)
  sodium.crypto_sign_detached(sig, canonical, kp.secretKey)
  return { ...body, signature: b4a.toString(sig, 'hex') }
}

function entryFor (kp, tableKey, seq) {
  return signEntry(kp, {
    tableKey,
    writer: kp.pubHex,
    seq,
    ts: Date.now(),
    payload: { kind: 'sit', seat: 0 } // opaque to the relay
  })
}

test('PokerApp - capability methods accept the P2P services-RPC object form', (t) => {
  const app = new PokerApp()
  const table = makeKeyPair()
  const alice = makeKeyPair()
  const tableKey = table.pubHex

  // createTable is already object-shaped; works for both HTTP and P2P.
  const desc = app.createTable({ tableKey, writers: [alice.pubHex], options: { bb: 2 } })
  t.ok(desc && Array.isArray(desc.writers), 'createTable returns a descriptor')

  // submitEntry object form: { tableKey, entry }
  const r0 = app.submitEntry({ tableKey, entry: entryFor(alice, tableKey, 0) })
  t.ok(r0 && r0.ok === true && r0.index === 0, 'submitEntry(object) appends')

  // positional form still works (regression — HTTP adapter path)
  const r1 = app.submitEntry(tableKey, entryFor(alice, tableKey, 1))
  t.ok(r1 && r1.ok === true && r1.index === 1, 'submitEntry(positional) still works')

  // getLog object form: { tableKey, from, limit }
  const log = app.getLog({ tableKey, from: 0 })
  t.is(log.entries.length, 2, 'getLog(object) returns both entries')

  // getState object form: { tableKey }
  const st = app.getState({ tableKey })
  t.is(st.length, 2, 'getState(object) reflects the appends')

  // listTables ignores args either way
  t.is(app.listTables().length, 1, 'listTables returns the table')
})

test('Router - poker.* are PUBLIC routes and dispatch with unpacked params', async (t) => {
  const app = new PokerApp()
  const table = makeKeyPair()
  const alice = makeKeyPair()
  const tableKey = table.pubHex
  app.createTable({ tableKey, writers: [alice.pubHex] })

  const registry = { services: new Map([['poker', { provider: app }]]) }
  const router = new Router({ registry })
  router.registerFromRegistry(registry)
  await router.start()

  // An invited player connects as an UNAUTHENTICATED remote peer. Before the
  // public-access policy this dispatch threw ACCESS_DENIED (default authenticated-user).
  const ctx = { transport: 'p2p', caller: 'remote', role: null, authenticated: false }

  const res = await router.dispatch(
    'poker.submitEntry',
    { tableKey, entry: entryFor(alice, tableKey, 0) },
    ctx
  )
  t.ok(res && res.ok === true, 'poker.submitEntry dispatched over public P2P route')

  const log = await router.dispatch('poker.getLog', { tableKey, from: 0 }, ctx)
  t.is(log.entries.length, 1, 'poker.getLog dispatched over public P2P route')

  const st = await router.dispatch('poker.getState', { tableKey }, ctx)
  t.is(st.length, 1, 'poker.getState dispatched over public P2P route')

  t.ok(router.routes().includes('poker.submitEntry'), 'poker routes auto-registered')

  await router.stop()
})

test('PokerApp - _emit fans out to global + per-table pubsub topics', (t) => {
  const got = []
  const app = new PokerApp()
  app.node = { router: { pubsub: { publish: (topic, data) => got.push([topic, data]) } } }

  const table = makeKeyPair()
  const alice = makeKeyPair()
  const tableKey = table.pubHex
  app.createTable({ tableKey, writers: [alice.pubHex] })

  const r = app.submitEntry({ tableKey, entry: entryFor(alice, tableKey, 0) })
  t.ok(r.ok, 'append ok')

  const topics = got.map(([tp]) => tp)
  t.ok(topics.includes('poker/entry'), 'global poker/entry topic published')
  t.ok(topics.includes('poker/entry/' + tableKey), 'per-table topic published')

  const perTable = got.find(([tp]) => tp === 'poker/entry/' + tableKey)
  t.is(perTable[1].index, 0, 'per-table payload carries the entry index')
  t.is(perTable[1].tableKey, tableKey, 'per-table payload carries the tableKey')
})
