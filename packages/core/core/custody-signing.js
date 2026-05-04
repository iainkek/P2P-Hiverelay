import b4a from 'b4a'
import sodium from 'sodium-universal'

const SIGNATURE_VERSION = 1
const FUTURE_SKEW_TOLERANCE_MS = 10 * 60 * 1000
const MAX_ENTRY_AGE_MS = 180 * 24 * 60 * 60 * 1000
const HEX_32 = /^[0-9a-f]{64}$/i
const HEX_SIG = /^[0-9a-f]{128}$/i
const FORBIDDEN_KEYS = new Set([
  'dataKey',
  'decryptionKey',
  'plaintext',
  'fileName',
  'filename',
  'path',
  'name',
  'description',
  'author',
  'categories'
])

const SIGNER_FIELD_BY_TYPE = {
  'custody-intent': 'publisherPubkey',
  'custody-commit': 'publisherPubkey',
  'source-retired': 'publisherPubkey',
  'custody-receipt': 'relayPubkey',
  'custody-proof': 'observerPubkey',
  'custody-non-serving-proof': 'relayPubkey'
}

const SIGNABLE_FIELDS_BY_TYPE = {
  'custody-intent': [
    'type',
    'version',
    'timestamp',
    'intentId',
    'custodyMode',
    'addressKey',
    'blindContentId',
    'contentType',
    'ciphertextRoot',
    'contentVersion',
    'publisherPubkey',
    'requiredReplicas',
    'candidateRelays',
    'deadline',
    'retainUntil',
    'privacyTier',
    'shardPolicy',
    'metadataVisibility',
    'policyHash'
  ],
  'custody-receipt': [
    'type',
    'version',
    'timestamp',
    'intentId',
    'custodyMode',
    'addressKey',
    'blindContentId',
    'ciphertextRoot',
    'contentVersion',
    'relayPubkey',
    'relayRegion',
    'shardIds',
    'anchored',
    'retainUntil',
    'storageCommitment'
  ],
  'custody-commit': [
    'type',
    'version',
    'timestamp',
    'intentId',
    'addressKey',
    'blindContentId',
    'ciphertextRoot',
    'contentVersion',
    'publisherPubkey',
    'relayQuorum',
    'receiptRoot',
    'nextAuthority'
  ],
  'source-retired': [
    'type',
    'version',
    'timestamp',
    'intentId',
    'addressKey',
    'blindContentId',
    'publisherPubkey',
    'retiredAtVersion',
    'nextAuthority'
  ],
  'custody-proof': [
    'type',
    'version',
    'timestamp',
    'intentId',
    'blindContentId',
    'relayPubkey',
    'challengeNonce',
    'shardIds',
    'blockIndices',
    'passed',
    'latencyMs',
    'observerPubkey'
  ],
  'custody-non-serving-proof': [
    'type',
    'version',
    'timestamp',
    'intentId',
    'addressKey',
    'blindContentId',
    'relayPubkey',
    'challengeNonce',
    'retainUntil',
    'notServing',
    'notServingReason',
    'catalogPresent',
    'activeSwarmServing',
    'limitationHash'
  ]
}

const ALLOWED_FIELDS_BY_TYPE = Object.fromEntries(
  Object.entries(SIGNABLE_FIELDS_BY_TYPE).map(([type, fields]) => [
    type,
    new Set([...fields, 'signature'])
  ])
)

export function isHex32 (value) {
  return typeof value === 'string' && HEX_32.test(value)
}

export function hashHex (value) {
  const input = typeof value === 'string' || b4a.isBuffer(value)
    ? b4a.from(value)
    : b4a.from(stableStringify(value))
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, input)
  return b4a.toString(out, 'hex')
}

export function computeReceiptRoot (receipts = []) {
  const leaves = receipts
    .map(receipt => receipt?.signature || stableStringify(stripSignature(receipt)))
    .sort()
  return hashHex({ type: 'custody-receipt-root-v1', leaves })
}

export function createCustodyIntent (fields, publisherKeyPair, opts = {}) {
  requireKeyPair(publisherKeyPair, 'publisherKeyPair')
  const now = Number.isFinite(opts.timestamp) ? opts.timestamp : Date.now()
  const publisherPubkey = b4a.toString(publisherKeyPair.publicKey, 'hex')
  const raw = {
    version: SIGNATURE_VERSION,
    timestamp: now,
    custodyMode: 'blind',
    contentType: 'shard-set',
    requiredReplicas: 3,
    candidateRelays: [],
    deadline: now + 10 * 60 * 1000,
    retainUntil: now + 30 * 24 * 60 * 60 * 1000,
    privacyTier: 'p2p-only',
    shardPolicy: 'all',
    metadataVisibility: 'redacted',
    policyHash: hashHex({ custodyMode: 'blind', metadataVisibility: 'redacted' }),
    ...fields,
    type: 'custody-intent',
    publisherPubkey
  }
  if (!raw.intentId) {
    raw.intentId = hashHex({
      type: 'custody-intent-id-v1',
      blindContentId: raw.blindContentId,
      ciphertextRoot: raw.ciphertextRoot,
      contentVersion: raw.contentVersion,
      publisherPubkey,
      timestamp: raw.timestamp
    })
  }
  const intent = normalizeCustodyEntry(raw)
  return signCustodyEntry(intent, publisherKeyPair)
}

export function createCustodyReceipt (fields, relayKeyPair, opts = {}) {
  requireKeyPair(relayKeyPair, 'relayKeyPair')
  const relayPubkey = b4a.toString(relayKeyPair.publicKey, 'hex')
  const raw = {
    version: SIGNATURE_VERSION,
    timestamp: Number.isFinite(opts.timestamp) ? opts.timestamp : Date.now(),
    custodyMode: 'blind',
    shardIds: [],
    anchored: true,
    ...fields,
    type: 'custody-receipt',
    relayPubkey
  }
  if (!raw.storageCommitment) {
    raw.storageCommitment = hashHex({
      type: 'custody-storage-commitment-v1',
      intentId: raw.intentId,
      blindContentId: raw.blindContentId,
      ciphertextRoot: raw.ciphertextRoot,
      contentVersion: raw.contentVersion,
      relayPubkey,
      shardIds: raw.shardIds,
      anchored: raw.anchored
    })
  }
  const receipt = normalizeCustodyEntry(raw)
  return signCustodyEntry(receipt, relayKeyPair)
}

export function createCustodyCommit (fields, publisherKeyPair, opts = {}) {
  requireKeyPair(publisherKeyPair, 'publisherKeyPair')
  const raw = {
    version: SIGNATURE_VERSION,
    timestamp: Number.isFinite(opts.timestamp) ? opts.timestamp : Date.now(),
    relayQuorum: [],
    nextAuthority: null,
    ...fields,
    type: 'custody-commit',
    publisherPubkey: b4a.toString(publisherKeyPair.publicKey, 'hex')
  }
  if (!raw.receiptRoot) raw.receiptRoot = computeReceiptRoot(fields.receipts || [])
  delete raw.receipts
  const commit = normalizeCustodyEntry(raw)
  return signCustodyEntry(commit, publisherKeyPair)
}

export function createSourceRetired (fields, publisherKeyPair, opts = {}) {
  requireKeyPair(publisherKeyPair, 'publisherKeyPair')
  const retired = normalizeCustodyEntry({
    version: SIGNATURE_VERSION,
    timestamp: Number.isFinite(opts.timestamp) ? opts.timestamp : Date.now(),
    nextAuthority: null,
    ...fields,
    type: 'source-retired',
    publisherPubkey: b4a.toString(publisherKeyPair.publicKey, 'hex')
  })
  return signCustodyEntry(retired, publisherKeyPair)
}

export function createCustodyProof (fields, observerKeyPair, opts = {}) {
  requireKeyPair(observerKeyPair, 'observerKeyPair')
  const nonce = b4a.alloc(32)
  sodium.randombytes_buf(nonce)
  const proof = normalizeCustodyEntry({
    version: SIGNATURE_VERSION,
    timestamp: Number.isFinite(opts.timestamp) ? opts.timestamp : Date.now(),
    challengeNonce: hashHex(nonce),
    shardIds: [],
    blockIndices: [],
    passed: false,
    latencyMs: 0,
    ...fields,
    type: 'custody-proof',
    observerPubkey: b4a.toString(observerKeyPair.publicKey, 'hex')
  })
  return signCustodyEntry(proof, observerKeyPair)
}

export function createCustodyNonServingProof (fields, relayKeyPair, opts = {}) {
  requireKeyPair(relayKeyPair, 'relayKeyPair')
  const nonce = b4a.alloc(32)
  sodium.randombytes_buf(nonce)
  const proof = normalizeCustodyEntry({
    version: SIGNATURE_VERSION,
    timestamp: Number.isFinite(opts.timestamp) ? opts.timestamp : Date.now(),
    challengeNonce: hashHex(nonce),
    notServing: true,
    notServingReason: 'expired-unseeded',
    catalogPresent: false,
    activeSwarmServing: false,
    limitationHash: hashHex('not-serving proof attests active relay state, not forensic disk erasure'),
    ...fields,
    type: 'custody-non-serving-proof',
    relayPubkey: b4a.toString(relayKeyPair.publicKey, 'hex')
  })
  return signCustodyEntry(proof, relayKeyPair)
}

export function signCustodyEntry (entry, keyPair) {
  requireKeyPair(keyPair, 'keyPair')
  const normalized = normalizeCustodyEntry(entry)
  const signature = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, custodySignablePayload(normalized), keyPair.secretKey)
  return {
    ...normalized,
    signature: b4a.toString(signature, 'hex')
  }
}

export function verifyCustodyEntry (entry, opts = {}) {
  try {
    const normalized = normalizeCustodyEntry(entry, opts)
    const signature = normalized.signature
    if (!HEX_SIG.test(signature || '')) return { valid: false, reason: 'bad signature shape' }

    const signerField = SIGNER_FIELD_BY_TYPE[normalized.type]
    const signer = normalized[signerField]
    if (!isHex32(signer)) return { valid: false, reason: `bad ${signerField}` }

    const ok = sodium.crypto_sign_verify_detached(
      b4a.from(signature, 'hex'),
      custodySignablePayload(normalized),
      b4a.from(signer, 'hex')
    )
    if (!ok) return { valid: false, reason: 'bad signature' }
    return { valid: true, entry: normalized }
  } catch (err) {
    return { valid: false, reason: err.message || String(err) }
  }
}

export function normalizeCustodyEntry (entry, opts = {}) {
  if (!entry || typeof entry !== 'object') throw new Error('custody entry required')
  if (containsForbiddenSecret(entry)) throw new Error('custody entry contains forbidden plaintext/key field')
  const type = String(entry.type || '').trim()
  if (!SIGNER_FIELD_BY_TYPE[type]) throw new Error('unsupported custody entry type')
  rejectUnknownFields(entry, type)
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const timestamp = numberField(entry.timestamp, 'timestamp')
  if (timestamp > now + FUTURE_SKEW_TOLERANCE_MS) throw new Error('timestamp too far in future')
  if (timestamp < now - MAX_ENTRY_AGE_MS) throw new Error('timestamp too old')

  const out = {
    ...entry,
    type,
    version: entry.version || SIGNATURE_VERSION,
    timestamp
  }

  if (out.version !== SIGNATURE_VERSION) throw new Error('unsupported custody version')
  out.intentId = hexField(out.intentId, 'intentId')

  if (type === 'custody-intent' || type === 'custody-receipt') {
    out.custodyMode = String(out.custodyMode || 'blind')
    if (out.custodyMode !== 'blind') throw new Error('custodyMode must be blind')
  }

  if (type !== 'source-retired' && type !== 'custody-proof' && type !== 'custody-non-serving-proof') {
    out.ciphertextRoot = hexField(out.ciphertextRoot, 'ciphertextRoot')
    out.contentVersion = numberField(out.contentVersion, 'contentVersion')
  }

  if (out.addressKey != null) out.addressKey = hexField(out.addressKey, 'addressKey')
  out.blindContentId = hexField(out.blindContentId, 'blindContentId')

  if (type === 'custody-intent') return normalizeIntent(out)
  if (type === 'custody-receipt') return normalizeReceipt(out)
  if (type === 'custody-commit') return normalizeCommit(out)
  if (type === 'source-retired') return normalizeSourceRetired(out)
  if (type === 'custody-proof') return normalizeProof(out)
  if (type === 'custody-non-serving-proof') return normalizeNonServingProof(out)
}

export function validateCustodyTransition (entry, status = {}) {
  if (!entry || !entry.type) return { valid: false, reason: 'entry required' }
  const intent = status.intent

  if (entry.type === 'custody-receipt') {
    if (!intent) return { valid: true }
    if (entry.blindContentId !== intent.blindContentId) return { valid: false, reason: 'blindContentId mismatch' }
    if (entry.ciphertextRoot !== intent.ciphertextRoot) return { valid: false, reason: 'ciphertextRoot mismatch' }
    if (entry.contentVersion !== intent.contentVersion) return { valid: false, reason: 'contentVersion mismatch' }
    if (entry.timestamp > intent.deadline) return { valid: false, reason: 'receipt after deadline' }
    if (entry.retainUntil < intent.retainUntil) return { valid: false, reason: 'retainUntil below intent' }
  }

  if (entry.type === 'custody-commit' || entry.type === 'source-retired') {
    if (intent && entry.publisherPubkey !== intent.publisherPubkey) {
      return { valid: false, reason: 'publisherPubkey mismatch' }
    }
  }

  if (entry.type === 'custody-commit' && intent) {
    const receipts = Array.isArray(status.receipts) ? status.receipts.filter(r => r.anchored === true) : []
    if (receipts.length < intent.requiredReplicas) return { valid: false, reason: 'quorum not reached' }
    const receiptRoot = computeReceiptRoot(receipts)
    if (entry.receiptRoot !== receiptRoot) return { valid: false, reason: 'receiptRoot mismatch' }
    const quorum = receipts.map(r => r.relayPubkey).sort()
    if (stableStringify(entry.relayQuorum) !== stableStringify(quorum)) {
      return { valid: false, reason: 'relayQuorum mismatch' }
    }
  }

  if (entry.type === 'source-retired' && !status.commit) {
    return { valid: false, reason: 'custody commit required before source retirement' }
  }

  if (entry.type === 'custody-non-serving-proof') {
    if (intent && entry.blindContentId !== intent.blindContentId) return { valid: false, reason: 'blindContentId mismatch' }
    if (intent && entry.addressKey !== intent.addressKey) return { valid: false, reason: 'addressKey mismatch' }
    if (intent && entry.retainUntil < intent.retainUntil) return { valid: false, reason: 'retainUntil below intent' }
    if (intent && entry.timestamp < intent.retainUntil) return { valid: false, reason: 'non-serving proof before retainUntil' }
    if (entry.notServing !== true) return { valid: false, reason: 'notServing must be true' }
    if (entry.catalogPresent || entry.activeSwarmServing) return { valid: false, reason: 'relay still reports active serving state' }
  }

  return { valid: true }
}

export function summarizeCustodyStatus (intent, receipts = [], commit = null, retirement = null, proofs = [], nonServingProofs = []) {
  const requiredReplicas = intent?.requiredReplicas || 0
  const validReceipts = receipts.filter(r => r.anchored === true)
  return {
    intentId: intent?.intentId || null,
    blindContentId: intent?.blindContentId || null,
    custodyMode: intent?.custodyMode || 'blind',
    requiredReplicas,
    receiptCount: validReceipts.length,
    quorumReached: requiredReplicas > 0 && validReceipts.length >= requiredReplicas,
    receiptRoot: computeReceiptRoot(validReceipts),
    relayQuorum: validReceipts.map(r => r.relayPubkey).sort(),
    committed: !!commit,
    sourceRetired: !!retirement,
    proofCount: proofs.length,
    passingProofs: proofs.filter(p => p.passed === true).length,
    nonServingProofCount: nonServingProofs.length,
    nonServingRelays: nonServingProofs.filter(p => p.notServing === true).map(p => p.relayPubkey).sort()
  }
}

function normalizeIntent (entry) {
  entry.publisherPubkey = hexField(entry.publisherPubkey, 'publisherPubkey')
  entry.requiredReplicas = positiveInteger(entry.requiredReplicas, 'requiredReplicas')
  entry.deadline = numberField(entry.deadline, 'deadline')
  entry.retainUntil = numberField(entry.retainUntil, 'retainUntil')
  entry.contentType = String(entry.contentType || 'shard-set')
  entry.candidateRelays = normalizeHexArray(entry.candidateRelays, 'candidateRelays')
  entry.shardPolicy = String(entry.shardPolicy || 'all')
  entry.privacyTier = String(entry.privacyTier || 'p2p-only')
  entry.metadataVisibility = String(entry.metadataVisibility || 'redacted')
  entry.policyHash = hexField(entry.policyHash || hashHex({
    privacyTier: entry.privacyTier,
    metadataVisibility: entry.metadataVisibility,
    shardPolicy: entry.shardPolicy
  }), 'policyHash')
  if (entry.privacyTier !== 'public' && entry.metadataVisibility !== 'redacted') {
    throw new Error('private custody metadataVisibility must be redacted')
  }
  return orderedEntry(entry)
}

function normalizeReceipt (entry) {
  entry.relayPubkey = hexField(entry.relayPubkey, 'relayPubkey')
  entry.relayRegion = typeof entry.relayRegion === 'string' && entry.relayRegion ? entry.relayRegion : 'unknown'
  entry.shardIds = normalizeIntegerArray(entry.shardIds, 'shardIds')
  entry.anchored = entry.anchored === true
  entry.retainUntil = numberField(entry.retainUntil, 'retainUntil')
  entry.storageCommitment = hexField(entry.storageCommitment, 'storageCommitment')
  return orderedEntry(entry)
}

function normalizeCommit (entry) {
  entry.publisherPubkey = hexField(entry.publisherPubkey, 'publisherPubkey')
  entry.relayQuorum = normalizeHexArray(entry.relayQuorum, 'relayQuorum')
  entry.receiptRoot = hexField(entry.receiptRoot, 'receiptRoot')
  if (entry.nextAuthority != null) entry.nextAuthority = hexField(entry.nextAuthority, 'nextAuthority')
  else entry.nextAuthority = null
  return orderedEntry(entry)
}

function normalizeSourceRetired (entry) {
  entry.publisherPubkey = hexField(entry.publisherPubkey, 'publisherPubkey')
  entry.retiredAtVersion = numberField(entry.retiredAtVersion, 'retiredAtVersion')
  if (entry.nextAuthority != null) entry.nextAuthority = hexField(entry.nextAuthority, 'nextAuthority')
  else entry.nextAuthority = null
  return orderedEntry(entry)
}

function normalizeProof (entry) {
  entry.relayPubkey = hexField(entry.relayPubkey, 'relayPubkey')
  entry.challengeNonce = hexField(entry.challengeNonce, 'challengeNonce')
  entry.shardIds = normalizeIntegerArray(entry.shardIds, 'shardIds')
  entry.blockIndices = normalizeIntegerArray(entry.blockIndices, 'blockIndices')
  entry.passed = entry.passed === true
  entry.latencyMs = nonNegativeNumber(entry.latencyMs, 'latencyMs')
  entry.observerPubkey = hexField(entry.observerPubkey, 'observerPubkey')
  return orderedEntry(entry)
}

function normalizeNonServingProof (entry) {
  entry.addressKey = hexField(entry.addressKey, 'addressKey')
  entry.relayPubkey = hexField(entry.relayPubkey, 'relayPubkey')
  entry.challengeNonce = hexField(entry.challengeNonce, 'challengeNonce')
  entry.retainUntil = numberField(entry.retainUntil, 'retainUntil')
  entry.notServing = entry.notServing === true
  entry.notServingReason = String(entry.notServingReason || 'expired-unseeded').slice(0, 120)
  entry.catalogPresent = entry.catalogPresent === true
  entry.activeSwarmServing = entry.activeSwarmServing === true
  entry.limitationHash = hexField(entry.limitationHash, 'limitationHash')
  return orderedEntry(entry)
}

function custodySignablePayload (entry) {
  const fields = SIGNABLE_FIELDS_BY_TYPE[entry.type]
  const pairs = fields.map(field => [field, entry[field] ?? null])
  return b4a.from(`hiverelay-${entry.type}-v1:${JSON.stringify(pairs)}`)
}

function stableStringify (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

function stripSignature (entry) {
  const out = { ...entry }
  delete out.signature
  return out
}

function orderedEntry (entry) {
  const out = {}
  for (const key of Object.keys(entry).sort()) out[key] = entry[key]
  return out
}

function containsForbiddenSecret (value) {
  if (!value || typeof value !== 'object') return false
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true
    if (child && typeof child === 'object' && containsForbiddenSecret(child)) return true
  }
  return false
}

function rejectUnknownFields (entry, type) {
  const allowed = ALLOWED_FIELDS_BY_TYPE[type]
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) throw new Error(`unknown custody field: ${key}`)
  }
}

function requireKeyPair (keyPair, name) {
  if (!keyPair || !keyPair.publicKey || !keyPair.secretKey) {
    throw new Error(`${name} { publicKey, secretKey } required`)
  }
}

function hexField (value, name) {
  if (!isHex32(value)) throw new Error(`${name} must be 64 hex characters`)
  return value.toLowerCase()
}

function numberField (value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return Math.floor(value)
}

function positiveInteger (value, name) {
  const n = numberField(value, name)
  if (n < 1) throw new Error(`${name} must be at least 1`)
  return n
}

function nonNegativeNumber (value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`)
  return value
}

function normalizeHexArray (value, name) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return [...new Set(value.map(v => hexField(v, name)))].sort()
}

function normalizeIntegerArray (value, name) {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return [...new Set(value.map(v => {
    if (!Number.isInteger(v) || v < 0) throw new Error(`${name} must contain non-negative integers`)
    return v
  }))].sort((a, b) => a - b)
}
