import test from 'brittle'
import { HiveRelayClient } from '../../packages/client/index.js'

const RELAY = 'ab'.repeat(32)

function directDialClient () {
  const calls = []
  const swarm = {
    joinPeer (key) { calls.push(['joinPeer', key.toString('hex')]) },
    async flush () { calls.push(['flush']) }
  }
  const client = new HiveRelayClient({ swarm, store: {} })
  client._started = true
  return { client, calls }
}

test('client direct relay API: production prototype dials a specific out-of-band relay', async (t) => {
  t.is(typeof HiveRelayClient.prototype.connectRelay, 'function', 'real client prototype exposes connectRelay')
  const { client, calls } = directDialClient()
  const connecting = client.connectRelay(RELAY, { timeoutMs: 100 })
  client.relays.set(RELAY, { channels: { service: {} } })
  client.emit('service-channel-open', { relay: RELAY })
  t.ok(await connecting, 'resolves when the requested relay service channel opens')
  t.alike(calls, [['joinPeer', RELAY], ['flush']], 'uses Hyperswarm direct peer dialing')
})
test('client direct relay API: already-open relay is idempotent and timeout is explicit', async (t) => {
  const ready = directDialClient()
  ready.client.relays.set(RELAY, { channels: { service: {} } })
  t.ok(await ready.client.connectRelay(RELAY), 'already-open relay resolves immediately')
  t.alike(ready.calls, [], 'idempotent path does not redial')

  const missing = directDialClient()
  t.absent(await missing.client.connectRelay(RELAY, { timeoutMs: 1 }), 'unreachable relay resolves false')
  t.exception(() => missing.client.connectRelay('not-a-key'), /64-char hex/, 'invalid relay key fails at the API boundary')
})
