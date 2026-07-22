import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { ServiceRegistry } from '../../packages/core/core/services/registry.js'
import { Seeder } from '../../packages/core/core/relay-node/seeder.js'
import { OpaqueCoreAvailabilityService } from '../../packages/services/builtin/opaque-core-availability-service.js'
import {
  createOpaqueCoreAvailabilityClient,
  createOpaqueCoreRegistration
} from '../../packages/client/opaque-core-availability.js'

function keyPair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

test('client relay.callService path registers, observes, and proves through the real Seeder', async (t) => {
  const caller = keyPair()
  const relayIdentity = keyPair()
  const coreKey = 'ab'.repeat(32)
  const fakeCore = {
    key: b4a.from(coreKey, 'hex'),
    discoveryKey: b4a.alloc(32, 7),
    length: 3,
    fork: 0,
    async ready () {},
    download () { return { async done () {}, destroy () {} } },
    async has (index) { return index >= 0 && index < 3 },
    async get (index, opts) {
      t.is(opts.wait, false, 'proof performs a local-only read')
      return b4a.from(`opaque-${index}`)
    },
    on () {},
    async close () {}
  }
  const storeCalls = []
  const store = {
    get ({ key }) {
      storeCalls.push(b4a.toString(key, 'hex'))
      return fakeCore
    }
  }
  const swarm = { joins: [], join (key) { this.joins.push(b4a.toString(key, 'hex')) }, async leave () {} }
  const seeder = new Seeder(store, swarm)
  await seeder.start()

  const registry = new ServiceRegistry({ metering: false })
  const service = new OpaqueCoreAvailabilityService({ now: () => 1_900_000_000_000 })
  registry.register(service)
  await registry.startAll({ node: { seeder, store, keyPair: relayIdentity }, keyPair: relayIdentity })

  const calls = []
  const relay = {
    async callService (serviceName, method, params) {
      calls.push({ serviceName, method })
      return registry.handleRequest(serviceName, method, params, {
        caller: 'remote',
        remotePubkey: b4a.toString(caller.publicKey, 'hex')
      })
    },
    async fetch () {
      throw new Error('operator HTTP /seed-core must not be used by table clients')
    }
  }
  const client = createOpaqueCoreAvailabilityClient(relay, { relayPubkey: relayIdentity.publicKey })
  const request = createOpaqueCoreRegistration({
    version: 1,
    coreKey,
    nonce: 'cd'.repeat(32),
    expiresAt: 1_900_000_030_000,
    keyPair: caller
  })

  const registered = await client.register(request)
  t.is(registered.code, 'REGISTERED')
  t.alike(storeCalls, [coreKey], 'only Seeder opens the registered public key')

  const status = await client.status({ version: 1, coreKey })
  t.is(status.code, 'AVAILABLE')
  t.is(status.observedLength, 3)
  t.is(status.contiguousLength, 3)

  const proof = await client.prove({
    version: 1,
    coreKey,
    index: 2,
    nonce: 'ef'.repeat(32),
    minLength: 3
  })
  t.is(proof.code, 'PROVED')
  t.is(proof.relayPubkey, b4a.toString(relayIdentity.publicKey, 'hex'))
  t.alike(calls, [
    { serviceName: 'opaque-core-availability', method: 'register' },
    { serviceName: 'opaque-core-availability', method: 'status' },
    { serviceName: 'opaque-core-availability', method: 'prove' }
  ], 'relay.callService is the only table-client transport')

  await registry.stopAll()
  await seeder.stop()
})
