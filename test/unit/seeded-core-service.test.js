import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { OpaqueCoreAvailabilityService } from '../../packages/services/builtin/opaque-core-availability-service.js'
import {
  OPAQUE_CORE_REGISTER_DOMAIN,
  createOpaqueCoreRegistration,
  verifyOpaqueCoreAvailabilityProof
} from '../../packages/services/builtin/opaque-core-availability-protocol.js'

const CORE_KEY = '11'.repeat(32)
const CALLER_A = keyPair()
const CALLER_B = keyPair()
const RELAY = keyPair()

function keyPair () {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function context (pair = CALLER_A) {
  return { caller: 'remote', remotePubkey: b4a.toString(pair.publicKey, 'hex') }
}

function core (opts = {}) {
  const calls = { ready: 0, has: 0, get: 0 }
  return {
    calls,
    key: b4a.from(CORE_KEY, 'hex'),
    length: opts.length ?? 4,
    fork: opts.fork ?? 0,
    async ready () { calls.ready++ },
    async has (index) { calls.has++; return opts.local !== false && index >= 0 && index < this.length },
    async get (index, options) {
      calls.get++
      if (!options || options.wait !== false) throw new Error('proof read must be local-only')
      return b4a.from(`block-${index}`)
    }
  }
}

function harness (opts = {}) {
  const seeded = new Map()
  const calls = { seed: [], storeGet: [], persist: 0 }
  const seededCore = opts.core || core(opts)
  const seeder = {
    cores: seeded,
    maxStorageBytes: opts.maxStorageBytes ?? 1024,
    totalBytesStored: opts.totalBytesStored ?? 0,
    hasCapacity: () => opts.hasCapacity !== false,
    async seedCore (key) {
      calls.seed.push(key)
      const entry = { core: seededCore, publicKeyHex: key, bytesStored: 0 }
      seeded.set(key, entry)
      calls.persist++
      return entry
    }
  }
  const store = {
    get ({ key }) {
      calls.storeGet.push(b4a.toString(key, 'hex'))
      throw new Error('untrusted key opened outside Seeder registry')
    }
  }
  const service = new OpaqueCoreAvailabilityService({
    now: opts.now || (() => 1_900_000_000_000),
    maxRegisteredCores: opts.maxRegisteredCores ?? 32,
    maxCoresPerCaller: opts.maxCoresPerCaller ?? 8,
    maxReplayEntries: opts.maxReplayEntries ?? 64,
    maxRegistrationTtlMs: opts.maxRegistrationTtlMs ?? 60_000,
    registrationsPerMin: opts.registrationsPerMin ?? 60,
    registrationBurst: opts.registrationBurst ?? 8
  })
  return service.start({ node: { seeder, store, keyPair: RELAY }, keyPair: RELAY })
    .then(() => ({ service, seeder, seeded, seededCore, calls }))
}

function registration (pair = CALLER_A, overrides = {}) {
  return createOpaqueCoreRegistration({
    version: 1,
    coreKey: CORE_KEY,
    nonce: '22'.repeat(32),
    expiresAt: 1_900_000_030_000,
    keyPair: pair,
    ...overrides
  })
}

test('opaque-core service manifest exposes exactly register/status/prove', async (t) => {
  const { service } = await harness()
  t.alike(service.manifest(), {
    name: 'opaque-core-availability',
    version: '1.0.0',
    description: 'Authenticated availability for opaque public Hypercores',
    capabilities: ['register', 'status', 'prove'],
    registrationDomain: OPAQUE_CORE_REGISTER_DOMAIN,
    proofProfile: 'retrievability-proof-v1'
  })
  await service.stop()
})

test('register binds the signed request to authenticated Noise remotePubkey', async (t) => {
  const { service, calls } = await harness()
  const result = await service.register(registration(), context())
  t.alike(result, {
    ok: true,
    code: 'REGISTERED',
    coreKey: CORE_KEY,
    observedLength: 4,
    contiguousLength: 4,
    fork: 0,
    seeding: true,
    idempotent: false
  })
  t.alike(calls.seed, [CORE_KEY])

  const mismatch = await service.register(registration(), context(CALLER_B))
  t.alike(mismatch, { ok: false, code: 'UNAUTHORIZED' })
  t.alike(calls.seed, [CORE_KEY], 'identity mismatch is rejected before Seeder access')
  await service.stop()
})

test('register rejects absent auth, bad shape, version, expiry, and signature before disk or proof work', async (t) => {
  const { service, calls, seededCore } = await harness()
  const cases = [
    [{ ...registration(), coreKey: 'bad' }, context(), 'BAD_CORE_KEY'],
    [{ ...registration(), nonce: 'bad' }, context(), 'BAD_NONCE'],
    [{ ...registration(), version: 2 }, context(), 'UNSUPPORTED_VERSION'],
    [{ ...registration(), expiresAt: 1_899_999_999_999 }, context(), 'EXPIRED'],
    [{ ...registration(), expiresAt: 1_900_000_600_000 }, context(), 'EXPIRY_TOO_FAR'],
    [{ ...registration(), signature: '00'.repeat(64) }, context(), 'BAD_SIGNATURE'],
    [registration(), { caller: 'remote' }, 'UNAUTHORIZED']
  ]
  for (const [request, caller, code] of cases) {
    t.alike(await service.register(request, caller), { ok: false, code }, code)
  }
  t.alike(calls.seed, [])
  t.alike(calls.storeGet, [])
  t.is(seededCore.calls.get, 0)
  await service.stop()
})

test('register is idempotent but nonce replay for a different request fails', async (t) => {
  const { service, calls } = await harness()
  const request = registration()
  t.is((await service.register(request, context())).code, 'REGISTERED')
  t.alike(await service.register(request, context()), {
    ok: true,
    code: 'REGISTERED',
    coreKey: CORE_KEY,
    observedLength: 4,
    contiguousLength: 4,
    fork: 0,
    seeding: true,
    idempotent: true
  })
  const replay = registration(CALLER_A, { coreKey: '33'.repeat(32) })
  t.alike(await service.register(replay, context()), { ok: false, code: 'REPLAYED_NONCE' })
  t.is(calls.seed.length, 1)
  t.ok(service.replayCacheSize <= 64, 'replay cache remains bounded')
  await service.stop()
})

test('register enforces per-caller, global, and storage-capacity bounds before open', async (t) => {
  const callerBound = await harness({ maxCoresPerCaller: 0 })
  t.alike(await callerBound.service.register(registration(), context()), { ok: false, code: 'CALLER_QUOTA' })
  t.alike(callerBound.calls.seed, [])
  await callerBound.service.stop()

  const globalBound = await harness({ maxRegisteredCores: 0 })
  t.alike(await globalBound.service.register(registration(), context()), { ok: false, code: 'GLOBAL_QUOTA' })
  t.alike(globalBound.calls.seed, [])
  await globalBound.service.stop()

  const capacity = await harness({ hasCapacity: false })
  t.alike(await capacity.service.register(registration(), context()), { ok: false, code: 'CAPACITY' })
  t.alike(capacity.calls.seed, [])
  t.alike(capacity.calls.storeGet, [])
  await capacity.service.stop()
})

test('status exposes bounded observed and contiguous local length only for registered keys', async (t) => {
  const { service, seeded, seededCore, calls } = await harness({ length: 5 })
  seeded.set(CORE_KEY, { core: seededCore, publicKeyHex: CORE_KEY })
  t.alike(await service.status({ version: 1, coreKey: CORE_KEY }, context()), {
    ok: true,
    code: 'AVAILABLE',
    coreKey: CORE_KEY,
    observedLength: 5,
    contiguousLength: 5,
    fork: 0,
    seeding: true
  })
  const unknown = await service.status({ version: 1, coreKey: '44'.repeat(32) }, context())
  const privateLike = await service.status({ version: 1, coreKey: '55'.repeat(32) }, context())
  t.alike(unknown, { ok: false, code: 'NOT_SEEDED' })
  t.alike(privateLike, unknown, 'unknown and disallowed keys are privacy-indistinguishable')
  t.alike(calls.storeGet, [], 'status never opens an unregistered caller key')
  await service.stop()
})

test('prove uses registered local blocks, minimum length, nonce, and relay identity', async (t) => {
  const { service, seeded, seededCore, calls } = await harness({ length: 4 })
  seeded.set(CORE_KEY, { core: seededCore, publicKeyHex: CORE_KEY })
  const challenge = {
    version: 1,
    coreKey: CORE_KEY,
    index: 2,
    nonce: '66'.repeat(32),
    minLength: 4
  }
  const proof = await service.prove(challenge, context())
  t.is(proof.ok, true)
  t.is(proof.code, 'PROVED')
  t.is(proof.observedLength, 4)
  t.is(proof.contiguousLength, 4)
  t.ok(await verifyOpaqueCoreAvailabilityProof({ response: proof, challenge, relayPubkey: RELAY.publicKey }))
  t.is(seededCore.calls.get, 1)
  t.alike(calls.storeGet, [])

  t.alike(await service.prove({ ...challenge, minLength: 5 }, context()), { ok: false, code: 'MIN_LENGTH_UNAVAILABLE' })
  t.alike(await service.prove({ ...challenge, coreKey: '77'.repeat(32) }, context()), { ok: false, code: 'NOT_SEEDED' })
  t.alike(calls.storeGet, [], 'prove keeps registry-before-open for unknown keys')
  await service.stop()
})

test('registered cores remain available after service restart through Seeder persistence', async (t) => {
  const first = await harness()
  await first.service.register(registration(), context())
  await first.service.stop()

  const second = await harness()
  second.seeded.set(CORE_KEY, { core: second.seededCore, publicKeyHex: CORE_KEY })
  await second.service.start({ node: { seeder: second.seeder, keyPair: RELAY }, keyPair: RELAY })
  t.is((await second.service.status({ version: 1, coreKey: CORE_KEY }, context())).code, 'AVAILABLE')
  await second.service.stop()
})
