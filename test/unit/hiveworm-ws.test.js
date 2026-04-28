import test from 'brittle'
import { WebSocket } from 'ws'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { HiveWormService } from 'p2p-hiverelay/core/hiveworm/relay-service.js'
import { RelayAPI } from 'p2p-hiverelay/core/relay-node/api.js'
import {
  SCHEMAS,
  DEFAULT_BIOME_CONFIG,
  canonicalPayload
} from 'p2p-hiverelay/core/hiveworm/index.js'

// ─── Helpers ───────────────────────────────────────────────────

function genWorm () {
  const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)
  return { pk: b4a.toString(pk, 'hex'), sk }
}

function genNonce () {
  const n = b4a.alloc(16)
  sodium.randombytes_buf(n)
  return b4a.toString(n, 'hex')
}

function signEntry (entry, sk) {
  const payload = canonicalPayload(entry)
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, payload, sk)
  return { ...entry, signature: b4a.toString(sig, 'hex') }
}

function makeBiomeKey (byte) {
  return b4a.toString(b4a.alloc(32, byte), 'hex')
}

function biomeInit (sk, pk, biomeKey, ts = Date.now()) {
  return signEntry({
    schema: SCHEMAS.BIOME_INIT,
    worm: pk,
    biome: biomeKey,
    ts,
    nonce: genNonce(),
    config: { ...DEFAULT_BIOME_CONFIG }
  }, sk)
}

function spawnEntry ({ pk, sk }, biomeKey, atPos, ts = Date.now()) {
  return signEntry({
    schema: SCHEMAS.SPAWN,
    worm: pk,
    biome: biomeKey,
    ts,
    nonce: genNonce(),
    atPos
  }, sk)
}

/**
 * Minimal RelayNode stand-in that satisfies RelayAPI's needs.
 */
function mockRelayNode (hiveworm) {
  return {
    running: true,
    config: { storage: null, registryAutoAccept: false },
    metrics: { getSummary () { return { uptime: 0 } } },
    hiveworm,
    seededApps: new Map(),
    appRegistry: {
      get () { return null },
      has () { return false },
      apps: new Map(),
      catalog () { return [] },
      catalogForBroadcast () { return [] }
    },
    getStats () { return { running: true, seededApps: 0, connections: 0 } },
    getHealthStatus () { return { healthy: true } },
    async stop () {},
    async seedApp () { return { ok: true } },
    async unseedApp () {},
    verifyUnseedRequest () { return { ok: true } },
    broadcastUnseed () {},
    router: { async dispatch () { return { ok: true } } },
    serviceRegistry: null,
    reputation: null,
    networkDiscovery: null,
    seedingRegistry: null,
    relay: null,
    seeder: null,
    swarm: null,
    on () {},
    emit () {},
    removeListener () {}
  }
}

/**
 * Open a WebSocket and start buffering inbound messages immediately so
 * waitMessage() never races the snapshot the server pushes on connect.
 * Resolves once the socket is OPEN.
 */
function openWs (url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws._inbox = []
    ws._waiters = []
    ws.on('message', (data) => {
      let msg
      try { msg = JSON.parse(data.toString()) } catch { return }
      // Try to dispatch to a waiter first; otherwise buffer.
      for (let i = 0; i < ws._waiters.length; i++) {
        const w = ws._waiters[i]
        if (w.predicate(msg)) {
          ws._waiters.splice(i, 1)
          clearTimeout(w.timer)
          w.resolve(msg)
          return
        }
      }
      ws._inbox.push(msg)
    })
    let settled = false
    ws.on('open', () => {
      if (settled) return
      settled = true
      resolve(ws)
    })
    ws.on('close', (code) => {
      if (settled) return
      settled = true
      reject(new Error('closed before open: code=' + code))
    })
    ws.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

/**
 * Wait for a single message matching a predicate. Returns the matching
 * message, draining it from the buffer if it has already arrived.
 */
function waitMessage (ws, predicate, timeoutMs = 1500) {
  // Drain buffered messages first
  for (let i = 0; i < ws._inbox.length; i++) {
    if (predicate(ws._inbox[i])) {
      const [msg] = ws._inbox.splice(i, 1)
      return Promise.resolve(msg)
    }
  }
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timer: null }
    waiter.timer = setTimeout(() => {
      const idx = ws._waiters.indexOf(waiter)
      if (idx !== -1) ws._waiters.splice(idx, 1)
      reject(new Error('timed out waiting for message'))
    }, timeoutMs)
    ws._waiters.push(waiter)
  })
}

async function setupServer (t) {
  const storage = await mkdtemp(join(tmpdir(), 'hiveworm-ws-test-'))
  const hiveworm = new HiveWormService({ storage })
  await hiveworm.start()

  const node = mockRelayNode(hiveworm)
  const api = new RelayAPI(node, { apiPort: 0, apiHost: '127.0.0.1', corsOrigins: '*' })
  await api.start()
  const port = api.server.address().port

  t.teardown(async () => {
    // Manual teardown — api.stop() awaits gateway.close() which hangs
    // when the mock node has no real corestore. The api-auth.test.js
    // suite uses the same pattern.
    if (api._dashboardFeed) {
      try { api._dashboardFeed.stop() } catch (_) {}
    }
    if (api._hiveWormFeed) {
      try { api._hiveWormFeed.stop() } catch (_) {}
    }
    if (api._rateLimitCleanup) clearInterval(api._rateLimitCleanup)
    if (api.server) {
      await new Promise((resolve) => api.server.close(() => resolve()))
    }
    await hiveworm.stop().catch(() => {})
    await rm(storage, { recursive: true, force: true }).catch(() => {})
  })

  return { api, hiveworm, node, port, storage }
}

// ─── Tests ─────────────────────────────────────────────────────

test('hiveworm-ws: rejects connection when hiveworm not enabled', async (t) => {
  const node = mockRelayNode(null)
  const api = new RelayAPI(node, { apiPort: 0, apiHost: '127.0.0.1', corsOrigins: '*' })
  await api.start()
  const port = api.server.address().port
  t.teardown(async () => {
    if (api._dashboardFeed) { try { api._dashboardFeed.stop() } catch (_) {} }
    if (api._hiveWormFeed) { try { api._hiveWormFeed.stop() } catch (_) {} }
    if (api._rateLimitCleanup) clearInterval(api._rateLimitCleanup)
    if (api.server) {
      await new Promise((resolve) => api.server.close(() => resolve()))
    }
  })

  const biomeKey = makeBiomeKey(0xa1)
  const url = `ws://127.0.0.1:${port}/api/hiveworm/${biomeKey}/events`
  const closeCode = await new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve('opened'))
    ws.on('error', () => { /* close will fire */ })
    ws.on('close', (code) => resolve(code))
  })
  t.absent(closeCode === 'opened', 'connection was rejected, not opened')
  t.ok(typeof closeCode === 'number', 'closed with a numeric code')
})

test('hiveworm-ws: rejects malformed biome key', async (t) => {
  const { port } = await setupServer(t)

  const url = `ws://127.0.0.1:${port}/api/hiveworm/not-hex/events`
  const closeCode = await new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve('opened'))
    ws.on('error', () => {})
    ws.on('close', (code) => resolve(code))
  })
  t.absent(closeCode === 'opened', 'connection was rejected')
})

test('hiveworm-ws: connection accepted and snapshot delivered', async (t) => {
  const { hiveworm, port } = await setupServer(t)
  const biomeKey = makeBiomeKey(0xa2)
  // Pre-create the biome with at least an init entry so getState returns
  // a meaningful snapshot.
  const w = genWorm()
  const init = biomeInit(w.sk, w.pk, biomeKey)
  const r = await hiveworm.appendMove(biomeKey, init)
  t.ok(r.ok, 'biome init appended')

  const ws = await openWs(`ws://127.0.0.1:${port}/api/hiveworm/${biomeKey}/events`)
  t.teardown(() => { try { ws.close() } catch {} })

  const snapshot = await waitMessage(ws, (m) => m.type === 'snapshot')
  t.is(snapshot.type, 'snapshot', 'snapshot type')
  t.ok(snapshot.state, 'state present')
  t.ok(Number.isInteger(snapshot.state.tick), 'tick is integer')
})

test('hiveworm-ws: new entries are broadcast to the subscriber', async (t) => {
  const { hiveworm, port } = await setupServer(t)
  const biomeKey = makeBiomeKey(0xa3)
  const w = genWorm()
  const init = biomeInit(w.sk, w.pk, biomeKey)
  await hiveworm.appendMove(biomeKey, init)

  const ws = await openWs(`ws://127.0.0.1:${port}/api/hiveworm/${biomeKey}/events`)
  t.teardown(() => { try { ws.close() } catch {} })

  await waitMessage(ws, (m) => m.type === 'snapshot')

  // Append a spawn after we're subscribed; expect to see it broadcast.
  const sp = spawnEntry(w, biomeKey, [10, 10])
  const expected = waitMessage(ws, (m) => m.type === 'entry')
  const r = await hiveworm.appendMove(biomeKey, sp)
  t.ok(r.ok, 'spawn appended')

  const event = await expected
  t.is(event.type, 'entry', 'entry type')
  t.is(event.entry.schema, SCHEMAS.SPAWN, 'spawn entry forwarded')
  t.is(event.entry.nonce, sp.nonce, 'same nonce relayed')
})

test('hiveworm-ws: multiple subscribers each receive the same broadcast', async (t) => {
  const { hiveworm, port } = await setupServer(t)
  const biomeKey = makeBiomeKey(0xa4)
  const w = genWorm()
  await hiveworm.appendMove(biomeKey, biomeInit(w.sk, w.pk, biomeKey))

  const wsA = await openWs(`ws://127.0.0.1:${port}/api/hiveworm/${biomeKey}/events`)
  const wsB = await openWs(`ws://127.0.0.1:${port}/api/hiveworm/${biomeKey}/events`)
  t.teardown(() => {
    try { wsA.close() } catch {}
    try { wsB.close() } catch {}
  })

  await waitMessage(wsA, (m) => m.type === 'snapshot')
  await waitMessage(wsB, (m) => m.type === 'snapshot')

  const sp = spawnEntry(w, biomeKey, [12, 12])
  const aGot = waitMessage(wsA, (m) => m.type === 'entry')
  const bGot = waitMessage(wsB, (m) => m.type === 'entry')

  const r = await hiveworm.appendMove(biomeKey, sp)
  t.ok(r.ok, 'spawn appended')

  const [eA, eB] = await Promise.all([aGot, bGot])
  t.is(eA.entry.nonce, sp.nonce, 'subscriber A saw entry')
  t.is(eB.entry.nonce, sp.nonce, 'subscriber B saw entry')
})

test('hiveworm-ws: disconnect cleans up the subscription', async (t) => {
  const { hiveworm, port } = await setupServer(t)
  const biomeKey = makeBiomeKey(0xa5)
  const w = genWorm()
  await hiveworm.appendMove(biomeKey, biomeInit(w.sk, w.pk, biomeKey))

  const ws = await openWs(`ws://127.0.0.1:${port}/api/hiveworm/${biomeKey}/events`)
  await waitMessage(ws, (m) => m.type === 'snapshot')

  const biome = hiveworm.biomes.get(biomeKey)
  t.ok(biome, 'biome loaded')
  t.is(biome.subscribers.size, 1, 'one subscriber attached')

  ws.close()
  // Wait for the close to propagate to the server-side connection.
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.is(biome.subscribers.size, 0, 'subscriber removed on disconnect')
})

test('hiveworm-ws: dashboard /ws endpoint still works alongside hiveworm-ws', async (t) => {
  const { port } = await setupServer(t)

  // Open the dashboard /ws endpoint and confirm we get an update payload.
  const ws = await openWs(`ws://127.0.0.1:${port}/ws`)
  t.teardown(() => { try { ws.close() } catch {} })

  const msg = await waitMessage(ws, (m) => m && (m.type === 'update' || m.overview))
  t.ok(msg, 'dashboard payload received')
})

test('hiveworm-ws: oversize incoming message closes the connection', async (t) => {
  const { hiveworm, port } = await setupServer(t)
  const biomeKey = makeBiomeKey(0xa6)
  const w = genWorm()
  await hiveworm.appendMove(biomeKey, biomeInit(w.sk, w.pk, biomeKey))

  const ws = await openWs(`ws://127.0.0.1:${port}/api/hiveworm/${biomeKey}/events`)
  await waitMessage(ws, (m) => m.type === 'snapshot')

  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  // Send 2KB — well over the 1KB limit
  ws.send('x'.repeat(2048))
  const code = await closed
  t.ok(typeof code === 'number', 'connection closed by server, code=' + code)
})

test('hiveworm-ws: incoming message rate-limit closes the connection', async (t) => {
  const { hiveworm, port } = await setupServer(t)
  const biomeKey = makeBiomeKey(0xa7)
  const w = genWorm()
  await hiveworm.appendMove(biomeKey, biomeInit(w.sk, w.pk, biomeKey))

  const ws = await openWs(`ws://127.0.0.1:${port}/api/hiveworm/${biomeKey}/events`)
  await waitMessage(ws, (m) => m.type === 'snapshot')

  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
  // Burst 20 small messages within a single second — over the 10/sec cap
  for (let i = 0; i < 20; i++) ws.send('hi')
  const code = await closed
  t.ok(typeof code === 'number', 'connection closed by server, code=' + code)
})
