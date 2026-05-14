// Verifies the publisher-signed API routes convert transient corestore /
// hypercore lifecycle errors into a retryable 503 (with Retry-After) so
// clients retry against the same relay instead of giving up on what looks
// like a permanent 400.
//
// Before the fix, drop-pear's escrow flow would see
//   400 {"error":"The corestore is closed"}
// from /api/v1/seed during a self-heal restart window (or when a hypercore
// was mid-close) and treat it as fatal because 400 = "your fault." Now
// the relay distinguishes "your request was malformed" (still 400) from
// "transient relay-side lifecycle state" (503 + Retry-After: 5).

import test from 'brittle'
import http from 'http'
import b4a from 'b4a'
import sodium from 'sodium-universal'

const API_KEY = 'test-secret-key-12345'

function keyPair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function request (port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: { 'Content-Type': 'application/json', ...headers }
    }
    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(data) } catch (_) { parsed = data }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// Minimal mock node. seedApp throws whatever the test installs; the
// seedingRegistry methods do the same. This is enough to exercise the
// error-classification branch in api.js without spinning up a real
// store/hypercore stack.
function makeMockNode () {
  let nextSeedAppError = null
  let nextIntentError = null
  let nextCommitError = null
  let nextRetiredError = null

  const registry = {
    getCustodyIntent () { return null },
    async publishCustodyIntent () {
      if (nextIntentError) throw nextIntentError
      return { ok: true, type: 'custody-intent' }
    },
    async publishCustodyCommit () {
      if (nextCommitError) throw nextCommitError
      return { ok: true, type: 'custody-commit' }
    },
    async publishSourceRetired () {
      if (nextRetiredError) throw nextRetiredError
      return { ok: true, type: 'source-retired' }
    }
  }

  const node = {
    running: true,
    config: { storage: null },
    metrics: { getSummary () { return { uptime: 100 } } },
    _catalogEntries: [],
    seededApps: new Map(),
    appRegistry: {
      get () { return null },
      has () { return false },
      apps: new Map(),
      catalog () { return [] },
      catalogForBroadcast () { return [] }
    },
    seedingRegistry: registry,
    appLifecycle: {},
    getStats () { return { running: true } },
    getHealthStatus () { return { healthy: true } },
    async stop () {},
    async seedApp () {
      if (nextSeedAppError) throw nextSeedAppError
      return { ok: true, accepted: true }
    },
    async unseedApp () {},
    verifyUnseedRequest () { return { ok: true } },
    broadcastUnseed () {},
    router: { async dispatch () { return { ok: true } } },
    serviceRegistry: null,
    reputation: null,
    networkDiscovery: null,
    relay: null,
    seeder: null,
    swarm: { keyPair: keyPair() },
    on () {},
    emit () {}
  }
  return {
    node,
    setSeedAppError (err) { nextSeedAppError = err },
    setIntentError (err) { nextIntentError = err },
    setCommitError (err) { nextCommitError = err },
    setRetiredError (err) { nextRetiredError = err }
  }
}

// Builds a valid publisher-signed seed-request body. We use the real
// canonical serializer so the v0.8.6 signature check passes — the test
// is about post-validation error handling, not signature verification.
async function signedSeedBody (publisherKp, appKeyHex = ('aa'.repeat(32))) {
  const { serializeSeedRequestForSigning } = await import('p2p-hiverelay/core/protocol/seed-request.js')
  const msg = {
    appKey: b4a.from(appKeyHex, 'hex'),
    discoveryKeys: [],
    replicationFactor: 3,
    maxStorageBytes: 500 * 1024 * 1024,
    ttlSeconds: 30 * 24 * 3600,
    bountyRate: 0,
    revocable: true,
    unseedFreezeMs: 0,
    durability: 0,
    publisherPubkey: publisherKp.publicKey,
    publisherSignature: b4a.alloc(64)
  }
  const payload = serializeSeedRequestForSigning(msg)
  sodium.crypto_sign_detached(msg.publisherSignature, payload, publisherKp.secretKey)
  return {
    appKey: appKeyHex,
    discoveryKeys: [],
    replicationFactor: 3,
    maxStorageBytes: 500 * 1024 * 1024,
    ttlSeconds: 30 * 24 * 3600,
    bountyRate: 0,
    revocable: true,
    unseedFreezeMs: 0,
    durability: 0,
    publisherPubkey: b4a.toString(publisherKp.publicKey, 'hex'),
    publisherSignature: b4a.toString(msg.publisherSignature, 'hex')
  }
}

let api = null
let port = 0
let fixture = null
let publisher = null

test('transient-errors: setup', async (t) => {
  const { RelayAPI } = await import('p2p-hiverelay/core/relay-node/api.js')
  fixture = makeMockNode()
  api = new RelayAPI(fixture.node, { apiPort: 0, apiKey: API_KEY, apiHost: '127.0.0.1' })
  await api.start()
  port = api.server.address().port
  publisher = keyPair()
  t.ok(port > 0)
})

// ─── /api/v1/seed ─────────────────────────────────────────────────────

test('/api/v1/seed: "The corestore is closed" → 503 with Retry-After', async (t) => {
  fixture.setSeedAppError(new Error('The corestore is closed'))
  const body = await signedSeedBody(publisher)
  const res = await request(port, 'POST', '/api/v1/seed', body)
  t.is(res.statusCode, 503, 'transient core error must return 503, not 400')
  t.is(res.headers['retry-after'], '5', 'Retry-After header set so the client knows to retry')
  t.ok(res.body.error.includes('corestore is closed'))
  t.is(res.body.retryable, true)
  fixture.setSeedAppError(null)
})

test('/api/v1/seed: "Cannot make sessions on a closing core" → 503', async (t) => {
  fixture.setSeedAppError(new Error('SESSION_CLOSED: Cannot make sessions on a closing core'))
  const body = await signedSeedBody(publisher)
  const res = await request(port, 'POST', '/api/v1/seed', body)
  t.is(res.statusCode, 503)
  t.is(res.headers['retry-after'], '5')
  t.is(res.body.retryable, true)
  fixture.setSeedAppError(null)
})

test('/api/v1/seed: other errors stay as 400 (backwards compat)', async (t) => {
  fixture.setSeedAppError(new Error('Storage capacity exceeded and no eligible app to evict'))
  const body = await signedSeedBody(publisher)
  const res = await request(port, 'POST', '/api/v1/seed', body)
  t.is(res.statusCode, 400, 'non-transient errors must still be 400 — no behaviour change for malformed-request cases')
  t.absent(res.headers['retry-after'])
  t.ok(res.body.error.includes('Storage capacity exceeded'))
  fixture.setSeedAppError(null)
})

// ─── /api/v1/custody/intent ───────────────────────────────────────────

test('/api/v1/custody/intent: "The corestore is closed" → 503 with Retry-After', async (t) => {
  fixture.setIntentError(new Error('The corestore is closed'))
  const res = await request(port, 'POST', '/api/v1/custody/intent', {
    type: 'custody-intent',
    signature: 'aa'.repeat(64) // pre-signed sentinel; mock doesn't verify
  })
  t.is(res.statusCode, 503)
  t.is(res.headers['retry-after'], '5')
  t.is(res.body.retryable, true)
  fixture.setIntentError(null)
})

test('/api/v1/custody/intent: code-based detection works', async (t) => {
  // Some hypercore versions surface a code instead of (or in addition to)
  // the message. Make sure code matching also produces a 503.
  const err = Object.assign(new Error('opaque'), { code: 'SESSION_CLOSED' })
  fixture.setIntentError(err)
  const res = await request(port, 'POST', '/api/v1/custody/intent', {
    type: 'custody-intent',
    signature: 'bb'.repeat(64)
  })
  t.is(res.statusCode, 503)
  t.is(res.headers['retry-after'], '5')
  fixture.setIntentError(null)
})

test('/api/v1/custody/intent: validation errors stay as 400', async (t) => {
  fixture.setIntentError(new Error('INVALID_CUSTODY_TRANSITION: cannot publish receipt before intent'))
  const res = await request(port, 'POST', '/api/v1/custody/intent', {
    type: 'custody-intent',
    signature: 'cc'.repeat(64)
  })
  t.is(res.statusCode, 400)
  t.absent(res.headers['retry-after'])
  fixture.setIntentError(null)
})

// ─── /api/v1/custody/{id}/commit ──────────────────────────────────────

test('/api/v1/custody/<id>/commit: corestore-closed → 503', async (t) => {
  fixture.setCommitError(new Error('The corestore is closed'))
  const intentId = 'dd'.repeat(32)
  const res = await request(port, 'POST', `/api/v1/custody/${intentId}/commit`, {
    type: 'custody-commit',
    signature: 'ee'.repeat(64)
  })
  t.is(res.statusCode, 503)
  t.is(res.headers['retry-after'], '5')
  fixture.setCommitError(null)
})

// ─── /api/v1/custody/{id}/source-retired ──────────────────────────────

test('/api/v1/custody/<id>/source-retired: corestore-closed → 503', async (t) => {
  fixture.setRetiredError(new Error('The corestore is closed'))
  const intentId = 'ff'.repeat(32)
  const res = await request(port, 'POST', `/api/v1/custody/${intentId}/source-retired`, {
    type: 'source-retired',
    signature: '11'.repeat(64)
  })
  t.is(res.statusCode, 503)
  t.is(res.headers['retry-after'], '5')
  fixture.setRetiredError(null)
})

// ─── teardown ─────────────────────────────────────────────────────────

test('transient-errors: teardown', async (t) => {
  if (api && api.server) {
    api.server.close()
    if (api._rateLimitCleanup) clearInterval(api._rateLimitCleanup)
    if (api._dashboardFeed) {
      try { api._dashboardFeed.stop() } catch (_) {}
    }
  }
  t.pass('server closed')
})
