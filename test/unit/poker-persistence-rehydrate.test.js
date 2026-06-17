// test/unit/poker-persistence-rehydrate.test.js
//
// Phase 12 Wave 1 — relay restart-durability + seeding.
//   - Auto-mirror hook is wired so tables created via ANY path are mirrored/seeded.
//   - A table's signed entries are mirrored to its per-table hypercore + the core
//     is seeded for cross-relay availability.
//   - After a relay "restart" (new PokerApp + new persistence over the SAME store),
//     rehydrateAll() rebuilds the table and its entries from disk — an in-flight hand
//     survives the restart (the in-memory SignedLog is otherwise lost).

import test from 'brittle'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import Corestore from 'corestore'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { SignedLog } from '../../packages/services/builtin/poker/signed-log.js'
import { PokerApp } from '../../packages/services/builtin/poker/index.js'
import { HypercorePersistence } from '../../packages/services/builtin/poker/persistence-hypercore.js'

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
  return signEntry(kp, { tableKey, writer: kp.pubHex, seq, ts: Date.now(), payload: { kind: 'sit', seat: seq } })
}
function fakeSeeder () {
  const seeded = []
  return { seeded, seedCore: async (hex) => { seeded.push(hex); return {} } }
}
async function waitFor (fn, ms = 3000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return false
}

test('Wave1 - autoMirror wires (and unwires) the PokerApp create-hook', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'poker-wave1-hook-'))
  const store = new Corestore(dir)
  const app = new PokerApp()
  const p = new HypercorePersistence({ pokerApp: app, store })
  t.is(typeof app._onTableCreated, 'function', 'create-hook installed by default')
  await p.stop()
  t.is(app._onTableCreated, null, 'create-hook removed on stop')
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test('Wave1 - table entries are mirrored to a seeded per-table core', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'poker-wave1-mirror-'))
  const store = new Corestore(dir)
  const app = new PokerApp()
  const seeder = fakeSeeder()
  // autoMirror off → drive deterministically (no racing async hook in the assertions).
  const p = new HypercorePersistence({ pokerApp: app, store, seeder, autoMirror: false })
  const alice = makeKeyPair()
  const TABLE = makeKeyPair().pubHex

  app.createTable({ tableKey: TABLE, writers: [alice.pubHex] })
  await p._onLiveTableCreated({ tableKey: TABLE, writers: [alice.pubHex], options: {} })

  t.ok(app.submitEntry(TABLE, entryFor(alice, TABLE, 0)).ok, 'entry 0 appended')
  t.ok(app.submitEntry(TABLE, entryFor(alice, TABLE, 1)).ok, 'entry 1 appended')

  const core = await p._coreFor(TABLE)
  t.ok(await waitFor(() => core.length === 2), 'both entries mirrored to the core')
  t.ok(seeder.seeded.includes(core.key.toString('hex')), 'table core was seeded')

  await p.stop()
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test('Wave1 - rehydrateAll rebuilds a table + entries after a relay restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'poker-wave1-restart-'))
  const alice = makeKeyPair()
  const TABLE = makeKeyPair().pubHex

  // ── Session 1: provision + play, then "crash" (close store) ──
  {
    const store = new Corestore(dir)
    const app = new PokerApp()
    const p = new HypercorePersistence({ pokerApp: app, store, seeder: fakeSeeder(), autoMirror: false })
    app.createTable({ tableKey: TABLE, writers: [alice.pubHex] })
    await p._onLiveTableCreated({ tableKey: TABLE, writers: [alice.pubHex], options: {} })
    app.submitEntry(TABLE, entryFor(alice, TABLE, 0))
    app.submitEntry(TABLE, entryFor(alice, TABLE, 1))
    const core = await p._coreFor(TABLE)
    t.ok(await waitFor(() => core.length === 2), 'entries persisted before restart')
    await p.stop()
    await store.close()
  }

  // ── Session 2: fresh PokerApp (no tables) + persistence over the SAME store ──
  {
    const store = new Corestore(dir)
    const app = new PokerApp()
    const p = new HypercorePersistence({ pokerApp: app, store, seeder: fakeSeeder(), autoMirror: false })

    t.absent(app.getState(TABLE), 'table is absent before rehydrate (fresh in-memory app)')
    const res = await p.rehydrateAll()
    t.is(res.rehydrated, 1, 'one table rehydrated')
    t.ok(res.tableKeys.includes(TABLE), 'the table key was rehydrated')

    const st = app.getState(TABLE)
    t.ok(st, 'table is live again after rehydrate')
    t.is(st.length, 2, 'both entries restored from disk')
    t.is(app.getLog(TABLE).entries.length, 2, 'log replayed with both entries')

    await p.stop()
    await store.close()
  }

  await rm(dir, { recursive: true, force: true })
})
