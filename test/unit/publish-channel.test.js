/**
 * PublishProtocol — verifies the publisher-signed submit channel that lets
 * external publishers submit custody-pipeline entries (intent / commit /
 * source-retired) over Protomux instead of HTTPS.
 *
 * Same fake-pair pattern as custody-channel.test.js — no real Hyperswarm
 * dialled. End-to-end integration over Protomux is covered separately by
 * a future testnet test once the wiring is reviewed.
 */

import test from 'brittle'
import { PublishProtocol, PublishProtocolClient, SUBMIT_KINDS } from 'p2p-hiverelay/core/protocol/publish-channel.js'

const SERVER_PUBKEY = 'aa'.repeat(32)
const CLIENT_PUBKEY = 'bb'.repeat(32)

/**
 * Wire a PublishProtocolClient (publisher) to a PublishProtocol (relay)
 * via fake in-memory message handlers, so we exercise the real onMessage
 * dispatch + RESULT routing without needing Hyperswarm. Each side gets a
 * `msgHandler.send` that calls the other's `_onMessage`.
 */
function fakePair (client, server) {
  client.channels.set(SERVER_PUBKEY, {
    channel: { close: () => {} },
    msgHandler: { send: (msg) => server._onMessage(CLIENT_PUBKEY, server.channels.get(CLIENT_PUBKEY).msgHandler, msg) },
    pending: new Map()
  })
  server.channels.set(CLIENT_PUBKEY, {
    channel: { close: () => {} },
    msgHandler: { send: (msg) => client._onMessage(SERVER_PUBKEY, msg) }
  })
  // Re-bind the client's entry so its pending map is the same the channel
  // dispatch reads.
  return { client, server }
}

// ─── Happy path per kind ─────────────────────────────────────────────────

test('PublishProtocol: SUBMIT_INTENT routes through onSubmitIntent handler', async (t) => {
  const seen = []
  const server = new PublishProtocol({
    onSubmitIntent: async (body) => {
      seen.push({ kind: 'intent', body })
      return { ok: true, result: { type: 'custody-intent', intentId: body.intentId } }
    }
  })
  const client = new PublishProtocolClient()
  fakePair(client, server)

  const res = await client.submit(SERVER_PUBKEY, 'intent', {
    type: 'custody-intent',
    intentId: 'ee'.repeat(32),
    signature: '11'.repeat(64)
  })

  t.is(res.ok, true)
  t.absent(res.error)
  t.is(res.result.type, 'custody-intent')
  t.is(seen.length, 1)
  t.is(seen[0].kind, 'intent')
})

test('PublishProtocol: SUBMIT_COMMIT routes through onSubmitCommit handler', async (t) => {
  const seen = []
  const server = new PublishProtocol({
    onSubmitCommit: async (body) => {
      seen.push({ kind: 'commit', body })
      return { ok: true, result: { type: 'custody-commit' } }
    }
  })
  const client = new PublishProtocolClient()
  fakePair(client, server)

  const res = await client.submit(SERVER_PUBKEY, 'commit', {
    type: 'custody-commit',
    intentId: 'aa'.repeat(32),
    signature: '22'.repeat(64)
  })

  t.is(res.ok, true)
  t.is(res.result.type, 'custody-commit')
  t.is(seen.length, 1)
})

test('PublishProtocol: SUBMIT_SOURCE_RETIRED routes through onSubmitSourceRetired handler', async (t) => {
  const seen = []
  const server = new PublishProtocol({
    onSubmitSourceRetired: async (body) => {
      seen.push({ kind: 'source-retired', body })
      return { ok: true, result: { type: 'source-retired' } }
    }
  })
  const client = new PublishProtocolClient()
  fakePair(client, server)

  const res = await client.submit(SERVER_PUBKEY, 'source-retired', {
    type: 'source-retired',
    intentId: 'bb'.repeat(32),
    signature: '33'.repeat(64)
  })

  t.is(res.ok, true)
  t.is(res.result.type, 'source-retired')
  t.is(seen.length, 1)
})

// ─── Error / edge cases ──────────────────────────────────────────────────

test('PublishProtocol: handler throw becomes ok:false with the error message', async (t) => {
  const server = new PublishProtocol({
    onSubmitIntent: async () => { throw new Error('INVALID_CUSTODY_TRANSITION: receipt before intent') }
  })
  const client = new PublishProtocolClient()
  fakePair(client, server)

  const res = await client.submit(SERVER_PUBKEY, 'intent', { type: 'custody-intent', signature: 'x' })
  t.is(res.ok, false)
  t.ok(res.error.includes('INVALID_CUSTODY_TRANSITION'))
  t.absent(res.retryable, 'thrown errors default retryable to undefined (treated as non-retryable)')
})

test('PublishProtocol: handler returning retryable:true propagates through to client', async (t) => {
  const server = new PublishProtocol({
    onSubmitIntent: async () => ({ ok: false, error: 'The corestore is closed', retryable: true })
  })
  const client = new PublishProtocolClient()
  fakePair(client, server)

  const res = await client.submit(SERVER_PUBKEY, 'intent', { type: 'custody-intent', signature: 'x' })
  t.is(res.ok, false)
  t.is(res.retryable, true)
  t.ok(res.error.includes('corestore is closed'))
})

test('PublishProtocol: unknown kind returns ok:false', async (t) => {
  const server = new PublishProtocol()
  const client = new PublishProtocolClient()
  fakePair(client, server)

  // Send a raw SUBMIT with a kind the client wrapper would have rejected
  // up front; we want to verify the server's defensive check.
  const entry = client.channels.get(SERVER_PUBKEY)
  const resPromise = new Promise(resolve => {
    entry.pending.set(99, { resolve, reject: () => {} })
  })
  entry.msgHandler.send({ type: 1, id: 99, kind: 'made-up-kind', body: {} })
  const res = await resPromise
  t.is(res.ok, false)
  t.ok(/unknown submit kind/.test(res.error))
})

test('PublishProtocol: missing body returns ok:false', async (t) => {
  const server = new PublishProtocol({
    onSubmitIntent: async () => { throw new Error('handler should not be called') }
  })
  const client = new PublishProtocolClient()
  fakePair(client, server)

  const entry = client.channels.get(SERVER_PUBKEY)
  const resPromise = new Promise(resolve => {
    entry.pending.set(7, { resolve, reject: () => {} })
  })
  entry.msgHandler.send({ type: 1, id: 7, kind: 'intent', body: null })
  const res = await resPromise
  t.is(res.ok, false)
  t.ok(/body must be an object/.test(res.error))
})

test('PublishProtocol: default handlers return ok:false when kind not wired', async (t) => {
  // Constructing without any handlers should yield a relay that rejects
  // every submit with a typed "not configured" error rather than throwing
  // or timing out.
  const server = new PublishProtocol()
  const client = new PublishProtocolClient()
  fakePair(client, server)

  for (const kind of SUBMIT_KINDS) {
    const res = await client.submit(SERVER_PUBKEY, kind, { type: kind, signature: 'x' })
    t.is(res.ok, false, `kind=${kind} must reject`)
    t.ok(/not configured on this relay/.test(res.error), `kind=${kind} error mentions not configured`)
  }
})

test('PublishProtocol: submitting unknown kind on the client rejects immediately', async (t) => {
  const client = new PublishProtocolClient()
  fakePair(client, new PublishProtocol())
  try {
    await client.submit(SERVER_PUBKEY, 'totally-fake', {})
    t.fail('should have rejected')
  } catch (err) {
    t.ok(/unknown submit kind/.test(err.message))
  }
})

test('PublishProtocol: submit on a non-attached remote rejects immediately', async (t) => {
  const client = new PublishProtocolClient()
  try {
    await client.submit('cc'.repeat(32), 'intent', {})
    t.fail('should have rejected')
  } catch (err) {
    t.ok(/no publish channel attached/.test(err.message))
  }
})

test('PublishProtocol: SUBMIT_KINDS includes seed (forward-compat with seed support)', (t) => {
  // 'seed' is included in the SUBMIT_KINDS contract so the client wrapper
  // doesn't reject it pre-flight. Server-side support is currently
  // omitted (returns "not configured on this relay") and lands in a
  // follow-up that extracts api.js's /seed validation into a shared helper.
  t.ok(SUBMIT_KINDS.has('seed'))
  t.ok(SUBMIT_KINDS.has('intent'))
  t.ok(SUBMIT_KINDS.has('commit'))
  t.ok(SUBMIT_KINDS.has('source-retired'))
})

// ─── Correlation / lifecycle ─────────────────────────────────────────────

test('PublishProtocol: concurrent submits correlate to the right resolves by id', async (t) => {
  const server = new PublishProtocol({
    onSubmitIntent: async (body) => {
      // Wait for an external signal so we can let the two requests race.
      await new Promise(resolve => setTimeout(resolve, body.delay))
      return { ok: true, result: { tag: body.tag } }
    }
  })
  const client = new PublishProtocolClient()
  fakePair(client, server)

  const [a, b, c] = await Promise.all([
    client.submit(SERVER_PUBKEY, 'intent', { type: 'custody-intent', tag: 'A', delay: 30 }),
    client.submit(SERVER_PUBKEY, 'intent', { type: 'custody-intent', tag: 'B', delay: 5 }),
    client.submit(SERVER_PUBKEY, 'intent', { type: 'custody-intent', tag: 'C', delay: 15 })
  ])

  t.is(a.result.tag, 'A', 'first submit gets A back even though it resolves last')
  t.is(b.result.tag, 'B')
  t.is(c.result.tag, 'C')
})

test('PublishProtocol: channel close rejects in-flight submits', async (t) => {
  const server = new PublishProtocol({
    onSubmitIntent: () => new Promise(() => {}) // never resolves
  })
  const client = new PublishProtocolClient()
  fakePair(client, server)

  const submitPromise = client.submit(SERVER_PUBKEY, 'intent', { type: 'custody-intent' })

  // Simulate channel close on the client side
  setImmediate(() => client._onClose(SERVER_PUBKEY))

  try {
    await submitPromise
    t.fail('should have rejected')
  } catch (err) {
    t.ok(/closed before result arrived/.test(err.message))
  }
})

test('PublishProtocol: submitTimeoutMs rejects after deadline', async (t) => {
  const server = new PublishProtocol({
    onSubmitIntent: () => new Promise(() => {}) // never resolves
  })
  const client = new PublishProtocolClient({ submitTimeoutMs: 50 })
  fakePair(client, server)

  try {
    await client.submit(SERVER_PUBKEY, 'intent', { type: 'custody-intent' })
    t.fail('should have timed out')
  } catch (err) {
    t.ok(/submit timeout/.test(err.message))
  }
})

test('PublishProtocol: emits submit-handled with outcome metadata', async (t) => {
  const handled = []
  const server = new PublishProtocol({
    onSubmitIntent: async () => ({ ok: true, result: {} }),
    onSubmitCommit: async () => { throw new Error('boom') }
  })
  server.on('submit-handled', (e) => handled.push(e))
  const client = new PublishProtocolClient()
  fakePair(client, server)

  await client.submit(SERVER_PUBKEY, 'intent', { type: 'custody-intent' })
  await client.submit(SERVER_PUBKEY, 'commit', { type: 'custody-commit' })

  t.is(handled.length, 2)
  t.is(handled[0].kind, 'intent')
  t.is(handled[0].ok, true)
  t.is(handled[1].kind, 'commit')
  t.is(handled[1].ok, false)
  t.ok(/boom/.test(handled[1].error))
})
