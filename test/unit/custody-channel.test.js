/**
 * CustodyProtocol — verifies the real-time push channel that broadcasts
 * custody entries between connected relays. Same fake-channel pattern as
 * the anchor channel tests; integration with real Protomux is covered by
 * observe-testnet-seeding.js end-to-end.
 */

import test from 'brittle'
import { CustodyProtocol } from 'p2p-hiverelay/core/protocol/custody-channel.js'

function fakePair (protoA, protoB, peerA = 'A', peerB = 'B') {
  protoA.channels.set(peerB, {
    channel: { close: () => {} },
    msgHandler: { send: (msg) => protoB._onMessage(peerA, msg) }
  })
  protoB.channels.set(peerA, {
    channel: { close: () => {} },
    msgHandler: { send: (msg) => protoA._onMessage(peerB, msg) }
  })
}

test('CustodyProtocol: broadcast pushes entry to all connected peers', async (t) => {
  const appliedB = []
  const appliedC = []
  const protoA = new CustodyProtocol()
  const protoB = new CustodyProtocol({
    applyEntry: async (entry) => { appliedB.push(entry); return true }
  })
  const protoC = new CustodyProtocol({
    applyEntry: async (entry) => { appliedC.push(entry); return true }
  })

  fakePair(protoA, protoB, 'A', 'B')
  fakePair(protoA, protoC, 'A', 'C')

  const entry = { type: 'custody-receipt', intentId: '0xdeadbeef', relayPubkey: 'A', timestamp: 1 }
  const sent = protoA.broadcast(entry)
  // Wait for async applyEntry calls to complete
  await new Promise(resolve => setImmediate(resolve))

  t.is(sent, 2, 'broadcast to 2 peers')
  t.is(appliedB.length, 1, 'B applied entry')
  t.is(appliedC.length, 1, 'C applied entry')
  t.is(appliedB[0].intentId, '0xdeadbeef')
})

test('CustodyProtocol: broadcast rejects entries with disallowed types', async (t) => {
  const applied = []
  const protoA = new CustodyProtocol()
  const protoB = new CustodyProtocol({
    applyEntry: async (entry) => { applied.push(entry); return true }
  })
  fakePair(protoA, protoB)

  const sent = protoA.broadcast({ type: 'seed-request', appKey: 'x' })
  await new Promise(resolve => setImmediate(resolve))
  t.is(sent, 0, 'no broadcast for non-custody type')
  t.is(applied.length, 0)
})

test('CustodyProtocol: receiving peer rejects entry with bad type', async (t) => {
  const protoA = new CustodyProtocol()
  let rejectReason = null
  const protoB = new CustodyProtocol({
    applyEntry: async () => { throw new Error('should not be called') }
  })
  protoB.on('reject-push', e => { rejectReason = e.reason })
  fakePair(protoA, protoB)

  // Bypass the broadcast filter — directly inject a bad entry into B
  protoA.channels.get('B').msgHandler.send({ type: 1, entry: { type: 'arbitrary-malicious-type' } })
  await new Promise(resolve => setImmediate(resolve))
  t.is(rejectReason, 'bad-type')
})

test('CustodyProtocol: applied event fires when entry is new', async (t) => {
  const protoA = new CustodyProtocol()
  const protoB = new CustodyProtocol({ applyEntry: async () => true })
  let applied = false
  protoB.on('applied', () => { applied = true })
  fakePair(protoA, protoB)

  protoA.broadcast({ type: 'custody-intent', intentId: 'x', timestamp: 1 })
  await new Promise(resolve => setImmediate(resolve))
  t.ok(applied, 'applied event fired')
})

test('CustodyProtocol: duplicate event fires when applyEntry returns false', async (t) => {
  const protoA = new CustodyProtocol()
  const protoB = new CustodyProtocol({ applyEntry: async () => false })
  let dup = false
  protoB.on('duplicate', () => { dup = true })
  fakePair(protoA, protoB)

  protoA.broadcast({ type: 'custody-intent', intentId: 'x', timestamp: 1 })
  await new Promise(resolve => setImmediate(resolve))
  t.ok(dup, 'duplicate event fired when receiver returned false')
})

test('CustodyProtocol: applyEntry exception emits apply-error', async (t) => {
  const protoA = new CustodyProtocol()
  const errors = []
  const protoB = new CustodyProtocol({
    applyEntry: async () => { throw new Error('db-write-failed') }
  })
  protoB.on('apply-error', e => errors.push(e))
  fakePair(protoA, protoB)

  protoA.broadcast({ type: 'custody-receipt', intentId: 'x', relayPubkey: 'r', timestamp: 1 })
  await new Promise(resolve => setImmediate(resolve))
  t.is(errors.length, 1)
  t.is(errors[0].error, 'db-write-failed')
})

test('CustodyProtocol: broadcast with no peers attached returns 0', async (t) => {
  const proto = new CustodyProtocol()
  const sent = proto.broadcast({ type: 'custody-intent', intentId: 'x', timestamp: 1 })
  t.is(sent, 0)
})

test('CustodyProtocol: detach removes peer from channels', async (t) => {
  const proto = new CustodyProtocol()
  proto.channels.set('B', { channel: { close: () => {} }, msgHandler: { send: () => {} } })
  t.is(proto.channels.size, 1)
  proto.detach('B')
  t.is(proto.channels.size, 0)
})
