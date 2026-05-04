/**
 * AnchorProtocol — verifies the request/response state machine independently
 * of the Protomux/SecretStream wiring. Each test injects a fake `channel`
 * entry that records sends, so we can drive both sides of the conversation
 * without spinning up real streams.
 *
 * Higher-level integration tests (observer-testnet) cover the real
 * Protomux + Hyperswarm path end-to-end.
 */

import test from 'brittle'
import { AnchorProtocol } from 'p2p-hiverelay/core/protocol/anchor-channel.js'

// Build a fake channel pair where A's sends become B's _onMessage inputs
function fakePair (protoA, protoB, peerA = 'A-pubkey', peerB = 'B-pubkey') {
  protoA.channels.set(peerB, {
    channel: { close: () => {} },
    msgHandler: { send: (msg) => protoB._onMessage(peerA, msg) }
  })
  protoB.channels.set(peerA, {
    channel: { close: () => {} },
    msgHandler: { send: (msg) => protoA._onMessage(peerB, msg) }
  })
}

test('AnchorProtocol: peer A requests proof, peer B responds via provider', async (t) => {
  const provided = []
  const protoB = new AnchorProtocol({
    proofProvider: async (appKey) => {
      provided.push(appKey)
      return { ok: true, proof: { schemaVersion: 1, appKey, anchored: true, signature: 'mock-sig' } }
    }
  })
  const protoA = new AnchorProtocol()
  fakePair(protoA, protoB)

  const result = await protoA.requestProof('B-pubkey', 'a'.repeat(64))
  t.is(result.ok, true)
  t.is(result.proof.appKey, 'a'.repeat(64))
  t.is(result.proof.anchored, true)
  t.is(provided.length, 1)
})

test('AnchorProtocol: ERROR response when proof not available', async (t) => {
  const protoB = new AnchorProtocol({
    proofProvider: async () => ({ ok: false, error: 'not-anchored' })
  })
  const protoA = new AnchorProtocol()
  fakePair(protoA, protoB)

  const result = await protoA.requestProof('B-pubkey', 'b'.repeat(64))
  t.is(result.ok, false)
  t.is(result.error, 'not-anchored')
})

test('AnchorProtocol: provider throw becomes provider-error response', async (t) => {
  const protoB = new AnchorProtocol({
    proofProvider: async () => { throw new Error('boom') }
  })
  const protoA = new AnchorProtocol()
  fakePair(protoA, protoB)

  const result = await protoA.requestProof('B-pubkey', 'c'.repeat(64))
  t.is(result.ok, false)
  t.ok(result.error.includes('provider-error'), 'error wraps provider exception')
})

test('AnchorProtocol: timeout returns error when peer never responds', async (t) => {
  // Channel exists but no responder — request will time out
  const proto = new AnchorProtocol({ requestTimeout: 50 })
  proto.channels.set('B-pubkey', {
    channel: { close: () => {} },
    msgHandler: { send: () => {} }
  })

  const result = await proto.requestProof('B-pubkey', 'd'.repeat(64))
  t.is(result.ok, false)
  t.is(result.error, 'timeout')
  proto.destroy()
})

test('AnchorProtocol: requestProof returns no-channel when peer not attached', async (t) => {
  const proto = new AnchorProtocol()
  const result = await proto.requestProof('unknown-peer', 'e'.repeat(64))
  t.is(result.ok, false)
  t.is(result.error, 'no-channel')
})

test('AnchorProtocol: destroy cleans up pending requests', async (t) => {
  const proto = new AnchorProtocol({ requestTimeout: 60_000 })
  proto.channels.set('B-pubkey', {
    channel: { close: () => {} },
    msgHandler: { send: () => {} }
  })

  const inflight = proto.requestProof('B-pubkey', 'f'.repeat(64))
  proto.destroy()
  const result = await inflight
  t.is(result.ok, false)
  t.is(result.error, 'destroyed')
})

test('AnchorProtocol: detach removes peer from channels map', async (t) => {
  const proto = new AnchorProtocol()
  proto.channels.set('B-pubkey', {
    channel: { close: () => {} },
    msgHandler: { send: () => {} }
  })
  t.is(proto.channels.size, 1)
  proto.detach('B-pubkey')
  t.is(proto.channels.size, 0)
})

test('AnchorProtocol: send-error caught and surfaced', async (t) => {
  const proto = new AnchorProtocol()
  proto.channels.set('B-pubkey', {
    channel: { close: () => {} },
    msgHandler: { send: () => { throw new Error('socket-closed') } }
  })

  const result = await proto.requestProof('B-pubkey', 'g'.repeat(64))
  t.is(result.ok, false)
  t.ok(result.error.includes('send-error'), 'error wraps send exception')
})
