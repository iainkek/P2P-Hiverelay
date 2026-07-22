import b4a from 'b4a'
import sodium from 'sodium-universal'
import { ServiceProvider } from 'p2p-hiverelay/core/services/provider.js'
import {
  buildStorageProof,
  PROOF_KIND_RETRIEVABILITY,
  RETRIEVABILITY_PROOF_LIMITATION,
  RETRIEVABILITY_PROOF_SIGNATURE_PROFILE
} from 'p2p-hiverelay/core/protocol/proof-of-storage.js'
import {
  OPAQUE_CORE_PROTOCOL_VERSION,
  OPAQUE_CORE_REGISTER_DOMAIN,
  hashOpaqueCoreProof,
  opaqueCoreProofBytes,
  verifyOpaqueCoreRegistration
} from './opaque-core-availability-protocol.js'

const HEX64 = /^[0-9a-f]{64}$/i
const MAX_PROOF_INDEX = 0xffffffff
const DEFAULT_MAX_REQUEST_BYTES = 1024

export class OpaqueCoreAvailabilityService extends ServiceProvider {
  constructor (opts = {}) {
    super()
    this._now = opts.now || Date.now
    this._maxRequestBytes = opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    this._maxRegisteredCores = opts.maxRegisteredCores ?? 4096
    this._maxCoresPerCaller = opts.maxCoresPerCaller ?? 128
    this._maxReplayEntries = opts.maxReplayEntries ?? 5000
    this._maxProofReplayEntries = opts.maxProofReplayEntries ?? 5000
    this._maxRegistrationTtlMs = opts.maxRegistrationTtlMs ?? 60_000

    this._registrationLimits = makeLimits(opts, 'registration', 60, 8, 600, 128)
    this._proofLimits = makeLimits(opts, 'proof', 120, 32, 1200, 400)
    this._maxBuckets = opts.maxBuckets ?? 5000
    this._bucketTtlMs = opts.bucketTtlMs ?? 10 * 60_000

    this._node = null
    this._keyPair = opts.keyPair || null
    this._registrationReplay = new Map()
    this._proofReplay = new Map()
    this._callerCores = new Map()
    this._registrationBuckets = new Map()
    this._proofBuckets = new Map()
    this._registrationGlobal = freshBucket(this._registrationLimits.globalBurst, 0)
    this._proofGlobal = freshBucket(this._proofLimits.globalBurst, 0)
    this._registerTail = Promise.resolve()
  }

  get replayCacheSize () { return this._registrationReplay.size }

  manifest () {
    return {
      name: 'opaque-core-availability',
      version: '1.0.0',
      description: 'Authenticated availability for opaque public Hypercores',
      capabilities: ['register', 'status', 'prove'],
      registrationDomain: OPAQUE_CORE_REGISTER_DOMAIN,
      proofProfile: RETRIEVABILITY_PROOF_SIGNATURE_PROFILE
    }
  }

  async start (context = {}) {
    this._node = context.node || null
    if (context.keyPair) this._keyPair = context.keyPair
    const now = this._now()
    this._registrationGlobal.lastRefill = now
    this._proofGlobal.lastRefill = now
    return this
  }

  async stop () {
    this._node = null
    this._registrationReplay.clear()
    this._proofReplay.clear()
    this._callerCores.clear()
    this._registrationBuckets.clear()
    this._proofBuckets.clear()
  }

  async register (request = {}, context = {}) {
    const caller = remoteCaller(context)
    if (!caller) return failure('UNAUTHORIZED')
    const normalized = normalizeRegistration(request, this._now(), this._maxRegistrationTtlMs, this._maxRequestBytes)
    if (!normalized.ok) return normalized
    if (normalized.callerPubkey !== caller) return failure('UNAUTHORIZED')
    if (!verifyOpaqueCoreRegistration(normalized)) return failure('BAD_SIGNATURE')

    const prior = this._registrationReplay.get(`${caller}:${normalized.nonce}`)
    const digest = registrationDigest(normalized)
    if (prior) {
      if (prior.digest !== digest) return failure('REPLAYED_NONCE')
      return this._registeredResponse(normalized.coreKey, true)
    }

    const run = this._registerTail.then(() => this._registerValidated(normalized, caller, digest))
    this._registerTail = run.catch(() => {})
    return run
  }

  async status (request = {}, context = {}) {
    if (!remoteCaller(context)) return failure('UNAUTHORIZED')
    const normalized = normalizeLookup(request, this._maxRequestBytes)
    if (!normalized.ok) return normalized
    const entry = resolveSeed(this._node, normalized.coreKey)
    if (!entry) return failure('NOT_SEEDED')
    return availableResponse(entry, normalized.coreKey)
  }

  async prove (request = {}, context = {}) {
    const caller = remoteCaller(context)
    if (!caller) return failure('UNAUTHORIZED')
    const challenge = normalizeChallenge(request, this._maxRequestBytes)
    if (!challenge.ok) return challenge

    const entry = resolveSeed(this._node, challenge.coreKey)
    if (!entry) return failure('NOT_SEEDED')
    const core = entry.core
    const observedLength = safeLength(core.length)
    if (observedLength < challenge.minLength) return failure('MIN_LENGTH_UNAVAILABLE')
    if (challenge.index >= observedLength) return failure('NOT_SEEDED')

    const replayKey = `${caller}:${challenge.nonce}`
    if (this._proofReplay.has(replayKey)) return failure('REPLAYED_NONCE')
    if (!takeRate(this._proofBuckets, caller, this._proofLimits, this._proofGlobal, this._now(), this._maxBuckets, this._bucketTtlMs)) {
      return failure('RATE_LIMITED')
    }
    remember(this._proofReplay, replayKey, true, this._maxProofReplayEntries)

    let local = false
    try { local = await core.has(challenge.index) } catch {}
    if (!local) return failure('NOT_SEEDED')

    let block
    try { block = await core.get(challenge.index, { wait: false }) } catch { return failure('NOT_SEEDED') }
    if (!block) return failure('NOT_SEEDED')

    const contiguousLength = await localContiguousLength(core, observedLength)
    if (contiguousLength <= challenge.index) return failure('NOT_SEEDED')
    const keyPair = this._keyPair || this._node?.keyPair || this._node?.swarm?.keyPair
    if (!keyPair || !keyPair.publicKey || !keyPair.secretKey) return failure('SERVICE_UNAVAILABLE')

    let contentProof = null
    if (core.core?.tree && core.core?.blocks) {
      try {
        contentProof = await buildStorageProof({
          core,
          index: challenge.index,
          nonce: b4a.from(challenge.nonce, 'hex'),
          keyPair,
          signatureProfile: RETRIEVABILITY_PROOF_SIGNATURE_PROFILE
        })
      } catch {
        return failure('NOT_SEEDED')
      }
    }

    const blockBytes = b4a.from(block)
    const blockHash = b4a.alloc(32)
    sodium.crypto_generichash(blockHash, blockBytes)
    const response = {
      ok: true,
      code: 'PROVED',
      version: OPAQUE_CORE_PROTOCOL_VERSION,
      proofKind: PROOF_KIND_RETRIEVABILITY,
      proofLimit: RETRIEVABILITY_PROOF_LIMITATION,
      signatureProfile: RETRIEVABILITY_PROOF_SIGNATURE_PROFILE,
      callerPubkey: caller,
      relayPubkey: b4a.toString(keyPair.publicKey, 'hex'),
      coreKey: challenge.coreKey,
      fork: coreFork(core),
      observedLength,
      contiguousLength,
      index: challenge.index,
      nonce: challenge.nonce,
      minLength: challenge.minLength,
      block: b4a.toString(blockBytes, 'hex'),
      blockHash: b4a.toString(blockHash, 'hex'),
      contentProof,
      contentProofHash: hashOpaqueCoreProof(contentProof)
    }
    const signature = b4a.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(signature, opaqueCoreProofBytes(response), keyPair.secretKey)
    response.signature = b4a.toString(signature, 'hex')
    return response
  }

  async _registerValidated (request, caller, digest) {
    const existing = resolveSeed(this._node, request.coreKey)
    if (existing) {
      remember(this._registrationReplay, `${caller}:${request.nonce}`, { digest }, this._maxReplayEntries)
      rememberCallerCore(this._callerCores, caller, request.coreKey)
      return availableResponse(existing, request.coreKey, { registered: true, idempotent: true })
    }

    const callerCores = this._callerCores.get(caller)
    if ((callerCores?.size || 0) >= this._maxCoresPerCaller) return failure('CALLER_QUOTA')
    const seeder = this._node?.seeder
    if (!seeder || typeof seeder.seedCore !== 'function') return failure('SERVICE_UNAVAILABLE')
    if ((seeder.cores?.size || 0) >= this._maxRegisteredCores) return failure('GLOBAL_QUOTA')
    if (typeof seeder.hasCapacity !== 'function' || !seeder.hasCapacity(0)) return failure('CAPACITY')
    if (!takeRate(this._registrationBuckets, caller, this._registrationLimits, this._registrationGlobal, this._now(), this._maxBuckets, this._bucketTtlMs)) {
      return failure('RATE_LIMITED')
    }

    let entry
    try { entry = await seeder.seedCore(request.coreKey) } catch { return failure('NOT_SEEDED') }
    const resolved = resolveSeed(this._node, request.coreKey) || entry
    if (!resolved || !resolved.core) return failure('NOT_SEEDED')

    remember(this._registrationReplay, `${caller}:${request.nonce}`, { digest }, this._maxReplayEntries)
    rememberCallerCore(this._callerCores, caller, request.coreKey)
    return availableResponse(resolved, request.coreKey, { registered: true, idempotent: false })
  }

  async _registeredResponse (coreKey, idempotent) {
    const entry = resolveSeed(this._node, coreKey)
    if (!entry) return failure('NOT_SEEDED')
    return availableResponse(entry, coreKey, { registered: true, idempotent })
  }
}

function normalizeRegistration (request, now, maxTtlMs, maxBytes) {
  if (!withinRequestLimit(request, maxBytes)) return failure('BAD_REQUEST')
  if (!request || request.version !== OPAQUE_CORE_PROTOCOL_VERSION) return failure('UNSUPPORTED_VERSION')
  if (!HEX64.test(request.coreKey || '')) return failure('BAD_CORE_KEY')
  if (!HEX64.test(request.nonce || '')) return failure('BAD_NONCE')
  if (!Number.isSafeInteger(request.expiresAt)) return failure('BAD_EXPIRY')
  if (request.expiresAt <= now) return failure('EXPIRED')
  if (request.expiresAt - now > maxTtlMs) return failure('EXPIRY_TOO_FAR')
  return { ...request, ok: true, coreKey: request.coreKey.toLowerCase(), nonce: request.nonce.toLowerCase(), callerPubkey: String(request.callerPubkey || '').toLowerCase() }
}

function normalizeLookup (request, maxBytes) {
  if (!withinRequestLimit(request, maxBytes)) return failure('BAD_REQUEST')
  if (!request || request.version !== OPAQUE_CORE_PROTOCOL_VERSION) return failure('UNSUPPORTED_VERSION')
  if (!HEX64.test(request.coreKey || '')) return failure('BAD_CORE_KEY')
  return { ok: true, coreKey: request.coreKey.toLowerCase() }
}

function normalizeChallenge (request, maxBytes) {
  const lookup = normalizeLookup(request, maxBytes)
  if (!lookup.ok) return lookup
  if (!Number.isSafeInteger(request.index) || request.index < 0 || request.index > MAX_PROOF_INDEX) return failure('BAD_INDEX')
  if (!HEX64.test(request.nonce || '')) return failure('BAD_NONCE')
  const minLength = request.minLength ?? 0
  if (!Number.isSafeInteger(minLength) || minLength < 0) return failure('BAD_MIN_LENGTH')
  return { ok: true, coreKey: lookup.coreKey, index: request.index, nonce: request.nonce.toLowerCase(), minLength }
}

function resolveSeed (node, coreKey) {
  const seeder = node?.seeder
  if (!seeder) return null
  if (typeof seeder.resolveSeededCore === 'function') return seeder.resolveSeededCore(coreKey)
  const entry = seeder.cores?.get(coreKey)
  return isPublicSeed(entry, coreKey) ? entry : null
}

function isPublicSeed (entry, coreKey) {
  if (!entry || !entry.core || entry.blind === true || entry.private === true) return false
  if (entry.privacyTier && String(entry.privacyTier).toLowerCase() !== 'public') return false
  if (entry.core.closed || entry.core.closing) return false
  const actualKey = entry.core.key && b4a.toString(entry.core.key, 'hex')
  return actualKey === coreKey
}

async function availableResponse (entry, coreKey, opts = {}) {
  const observedLength = safeLength(entry.core.length)
  const contiguousLength = await localContiguousLength(entry.core, observedLength)
  if (opts.registered) {
    return { ok: true, code: 'REGISTERED', coreKey, observedLength, contiguousLength, fork: coreFork(entry.core), seeding: true, idempotent: opts.idempotent }
  }
  return { ok: true, code: 'AVAILABLE', coreKey, observedLength, contiguousLength, fork: coreFork(entry.core), seeding: true }
}

async function localContiguousLength (core, observedLength) {
  if (Number.isSafeInteger(core.contiguousLength) && core.contiguousLength >= 0) {
    return Math.min(core.contiguousLength, observedLength)
  }
  let length = 0
  while (length < observedLength) {
    let held = false
    try { held = await core.has(length) } catch {}
    if (!held) break
    length++
  }
  return length
}

function coreFork (core) {
  const fork = core.fork ?? core.core?.tree?.fork ?? 0
  return Number.isSafeInteger(fork) && fork >= 0 ? fork : 0
}

function remoteCaller (context) {
  const value = context && context.remotePubkey
  if (typeof value === 'string' && HEX64.test(value)) return value.toLowerCase()
  if (value && value.byteLength === 32) return b4a.toString(value, 'hex')
  return null
}

function withinRequestLimit (request, maxBytes) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false
  try { return b4a.byteLength(JSON.stringify(request)) <= maxBytes } catch { return false }
}

function registrationDigest (request) {
  const digest = b4a.alloc(32)
  sodium.crypto_generichash(digest, b4a.from(JSON.stringify([request.version, request.coreKey, request.nonce, request.expiresAt, request.callerPubkey, request.signature]), 'utf8'))
  return b4a.toString(digest, 'hex')
}

function failure (code) { return { ok: false, code } }
function safeLength (value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0 }

function remember (map, key, value, max) {
  if (max <= 0) return
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value)
}

function rememberCallerCore (map, caller, coreKey) {
  let cores = map.get(caller)
  if (!cores) { cores = new Set(); map.set(caller, cores) }
  cores.add(coreKey)
}

function makeLimits (opts, prefix, perMin, burst, globalPerMin, globalBurst) {
  const plural = prefix === 'proof' ? 'proofs' : 'registrations'
  return {
    perMin: opts[`${plural}PerMin`] ?? perMin,
    burst: opts[`${prefix}Burst`] ?? burst,
    globalPerMin: opts[`global${prefix[0].toUpperCase()}${prefix.slice(1)}sPerMin`] ?? globalPerMin,
    globalBurst: opts[`global${prefix[0].toUpperCase()}${prefix.slice(1)}Burst`] ?? globalBurst
  }
}

function freshBucket (tokens, now) { return { tokens, lastRefill: now } }

function takeRate (buckets, caller, limits, global, now, maxBuckets, ttlMs) {
  evictBuckets(buckets, now, maxBuckets, ttlMs)
  let bucket = buckets.get(caller)
  if (!bucket) { bucket = freshBucket(limits.burst, now); buckets.set(caller, bucket) }
  refill(bucket, limits.perMin, limits.burst, now)
  refill(global, limits.globalPerMin, limits.globalBurst, now)
  if (bucket.tokens < 1 || global.tokens < 1) return false
  bucket.tokens--
  global.tokens--
  return true
}

function refill (bucket, perMin, burst, now) {
  const elapsed = Math.max(0, now - bucket.lastRefill)
  bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / 60_000) * perMin)
  bucket.lastRefill = now
}

function evictBuckets (buckets, now, max, ttl) {
  for (const [key, bucket] of buckets) if (now - bucket.lastRefill > ttl) buckets.delete(key)
  while (buckets.size >= max && buckets.size > 0) {
    let oldestKey = null
    let oldest = Infinity
    for (const [key, bucket] of buckets) {
      if (bucket.lastRefill < oldest) { oldest = bucket.lastRefill; oldestKey = key }
    }
    buckets.delete(oldestKey)
  }
}
