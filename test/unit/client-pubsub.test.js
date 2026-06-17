import test from 'brittle'
import { HiveRelayClient } from 'p2p-hiverelay-client'
import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'

function mockSwarm () {
  const swarm = new EventEmitter()
  swarm.keyPair = { publicKey: Buffer.alloc(32, 0xaa), secretKey: null }
  swarm.connections = new Set()
  swarm.join = () => ({ destroy: () => {} })
  swarm.leave = async () => {}
  swarm.flush = async () => {}
  swarm.destroy = async () => {}
  return swarm
}

function mockStore () {
  return {
    close: async () => {},
    get: () => ({ key: Buffer.alloc(32), ready: async () => {} })
  }
}

function makeClient () {
  const swarm = mockSwarm()
  const store = mockStore()
  const client = new HiveRelayClient({ swarm, store })
  client._started = true
  return client
}

function fakeServiceChannel () {
  const sent = []
  return {
    channel: { close: () => {} },
    msg: {
      send: (msg) => sent.push(JSON.parse(JSON.stringify(msg)))
    },
    _sent: sent
  }
}

function insertRelay (client, pubkey, svc) {
  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: null, circuit: null, service: svc },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })
  client._relayScores.set(pubkey, {
    successes: 1, failures: 0, latency: 10, connectedSince: Date.now()
  })
}

// ─── Constructor state ───

test('HiveRelayClient - _serviceTopicHandlers initialized as Map', (t) => {
  const client = new HiveRelayClient({ swarm: mockSwarm(), store: mockStore() })
  t.ok(client._serviceTopicHandlers instanceof Map)
  t.is(client._serviceTopicHandlers.size, 0)
})

// ─── subscribeService ───

test('subscribeService - sends MSG_SUBSCRIBE (type 4) frame with correct topics', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/' + pubkey.slice(0, 16)
  client.subscribeService([topic], () => {}, { relay: pubkey })

  t.is(svc._sent.length, 1)
  const frame = svc._sent[0]
  t.is(frame.type, 4)
  t.ok(Array.isArray(frame.topics))
  t.ok(frame.topics.includes(topic))
})

test('subscribeService - registers handler in _serviceTopicHandlers', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/abc'
  const handler = () => {}
  client.subscribeService([topic], handler, { relay: pubkey })

  t.ok(client._serviceTopicHandlers.has(topic))
  t.ok(client._serviceTopicHandlers.get(topic).has(handler))
})

test('subscribeService - skips topics that exceed 256 chars', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const tooLong = 'x'.repeat(257)
  const valid = 'poker/entry/abc'
  client.subscribeService([tooLong, valid], () => {}, { relay: pubkey })

  t.is(svc._sent.length, 1)
  const frame = svc._sent[0]
  t.absent(frame.topics.includes(tooLong))
  t.ok(frame.topics.includes(valid))
})

test('subscribeService - throws NO_RELAY when no relays', (t) => {
  const client = makeClient()
  t.exception(() => client.subscribeService(['poker/entry/x'], () => {}), /NO_RELAY/)
})

test('subscribeService - throws NO_SERVICE_CHANNEL when relay has no service', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  client.relays.set(pubkey, {
    conn: {},
    channels: { seed: null, circuit: null },
    connectedAt: Date.now(),
    lastSeen: Date.now()
  })
  client._relayScores.set(pubkey, { successes: 1, failures: 0, latency: 10, connectedSince: Date.now() })

  t.exception(
    () => client.subscribeService(['poker/entry/x'], () => {}, { relay: pubkey }),
    /NO_SERVICE_CHANNEL/
  )
})

// ─── MSG_EVENT dispatch ───

test('_onServiceMessage MSG_EVENT (type 6) - invokes handler with (topic, data)', (t) => {
  t.plan(2)
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/' + pubkey.slice(0, 16)
  client.subscribeService([topic], (receivedTopic, receivedData) => {
    t.is(receivedTopic, topic)
    t.alike(receivedData, { index: 0, payload: 'abc' })
  }, { relay: pubkey })

  client._onServiceMessage(pubkey, { type: 6, topic, data: { index: 0, payload: 'abc' } })
})

test('_onServiceMessage MSG_EVENT - emits service-event on client', (t) => {
  t.plan(3)
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/xyz'
  client.subscribeService([topic], () => {}, { relay: pubkey })

  client.on('service-event', ({ relay, topic: t2, data }) => {
    t.is(relay, pubkey)
    t.is(t2, topic)
    t.alike(data, { seq: 5 })
  })

  client._onServiceMessage(pubkey, { type: 6, topic, data: { seq: 5 } })
})

test('_onServiceMessage MSG_EVENT - a throwing handler does not crash the loop', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/xyz'
  let secondCalled = false

  client.subscribeService([topic], () => { throw new Error('boom') }, { relay: pubkey })
  client._serviceTopicHandlers.get(topic).add(() => { secondCalled = true })

  t.execution(() => client._onServiceMessage(pubkey, { type: 6, topic, data: {} }))
  t.ok(secondCalled)
})

test('_onServiceMessage MSG_EVENT - no-op for unknown topic', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  insertRelay(client, pubkey, fakeServiceChannel())

  // Should not throw even with no subscription for this topic
  t.execution(() => client._onServiceMessage(pubkey, { type: 6, topic: 'unknown/topic', data: {} }))
})

// ─── unsubscribeService / returned handle ───

test('returned unsubscribe handle sends MSG_UNSUBSCRIBE (type 5) frame', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/abc'
  const unsub = client.subscribeService([topic], () => {}, { relay: pubkey })

  const sentBefore = svc._sent.length
  unsub()

  // Should have sent a type-5 frame after the initial type-4
  const unsubFrames = svc._sent.slice(sentBefore).filter(f => f.type === 5)
  t.is(unsubFrames.length, 1)
  t.ok(unsubFrames[0].topics.includes(topic))
})

test('unsubscribeService - removes handler; subsequent MSG_EVENT not dispatched', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/abc'
  let callCount = 0
  const unsub = client.subscribeService([topic], () => { callCount++ }, { relay: pubkey })

  // Handler fires before unsub
  client._onServiceMessage(pubkey, { type: 6, topic, data: {} })
  t.is(callCount, 1)

  unsub()

  // Handler must not fire after unsub
  client._onServiceMessage(pubkey, { type: 6, topic, data: {} })
  t.is(callCount, 1)
})

test('unsubscribeService - does not send type-5 if other handlers still subscribed', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/abc'
  const handler1 = () => {}
  const handler2 = () => {}

  client.subscribeService([topic], handler1, { relay: pubkey })
  // Add a second handler directly so we don't send another type-4
  client._serviceTopicHandlers.get(topic).add(handler2)

  const sentBefore = svc._sent.length
  // Unsubscribe only handler1 — handler2 still present, no type-5 expected
  client.unsubscribeService([topic], handler1, { relay: pubkey })

  const unsubFrames = svc._sent.slice(sentBefore).filter(f => f.type === 5)
  t.is(unsubFrames.length, 0)
  t.ok(client._serviceTopicHandlers.has(topic))
})

// ─── Reconnect resubscribe ───

test('service-channel-open resubscribe - sends type-4 with all active topics', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const topic = 'poker/entry/' + pubkey.slice(0, 16)
  client.subscribeService([topic], () => {}, { relay: pubkey })

  const sentBefore = svc._sent.length

  // Simulate service channel re-open
  client.emit('service-channel-open', { relay: pubkey })

  // Must have sent a fresh type-4 frame with the active topic
  const resubFrames = svc._sent.slice(sentBefore).filter(f => f.type === 4)
  t.is(resubFrames.length, 1)
  t.ok(resubFrames[0].topics.includes(topic))
})

test('service-channel-open resubscribe - no-op when no active subscriptions', (t) => {
  const client = makeClient()
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)

  const sentBefore = svc._sent.length
  client.emit('service-channel-open', { relay: pubkey })

  t.is(svc._sent.length, sentBefore)
})

test('service-channel-open resubscribe - no-op for relay not in client.relays', (t) => {
  const client = makeClient()
  // Subscribe with a real relay first so _serviceTopicHandlers is non-empty
  const pubkey = randomBytes(32).toString('hex')
  const svc = fakeServiceChannel()
  insertRelay(client, pubkey, svc)
  client.subscribeService(['poker/entry/abc'], () => {}, { relay: pubkey })

  // Emit open for an unknown relay — must not throw
  t.execution(() => client.emit('service-channel-open', { relay: 'deadbeef' }))
})
