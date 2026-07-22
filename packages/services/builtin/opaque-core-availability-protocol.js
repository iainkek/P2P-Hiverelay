import b4a from 'b4a'
import sodium from 'sodium-universal'
import {
  RETRIEVABILITY_PROOF_LIMITATION,
  RETRIEVABILITY_PROOF_SIGNATURE_PROFILE,
  verifyStorageProof
} from 'p2p-hiverelay/core/protocol/proof-of-storage.js'

export const OPAQUE_CORE_REGISTER_DOMAIN = 'hiverelay.opaque-core-availability.register.v1'
export const OPAQUE_CORE_PROOF_DOMAIN = 'hiverelay.opaque-core-availability.proof.v1'
export const OPAQUE_CORE_PROTOCOL_VERSION = 1

const HEX64 = /^[0-9a-f]{64}$/i
const HEX128 = /^[0-9a-f]{128}$/i

export function createOpaqueCoreRegistration ({
  version = OPAQUE_CORE_PROTOCOL_VERSION,
  coreKey,
  nonce,
  expiresAt,
  keyPair
} = {}) {
  const callerPubkey = keyPair && keyPair.publicKey
    ? b4a.toString(keyPair.publicKey, 'hex')
    : ''
  const request = {
    version,
    coreKey: normalizeHex(coreKey),
    nonce: normalizeHex(nonce),
    expiresAt,
    callerPubkey
  }
  if (!keyPair || !keyPair.secretKey || !HEX64.test(callerPubkey)) {
    throw new Error('createOpaqueCoreRegistration requires an Ed25519 key pair')
  }
  const signature = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, registrationBytes(request), keyPair.secretKey)
  return { ...request, signature: b4a.toString(signature, 'hex') }
}

export function verifyOpaqueCoreRegistration (request) {
  if (!request || typeof request !== 'object') return false
  if (!HEX64.test(request.callerPubkey || '') || !HEX128.test(request.signature || '')) return false
  try {
    return sodium.crypto_sign_verify_detached(
      b4a.from(request.signature, 'hex'),
      registrationBytes(request),
      b4a.from(request.callerPubkey, 'hex')
    )
  } catch {
    return false
  }
}

export function opaqueCoreProofBytes (response) {
  return b4a.from(JSON.stringify([
    OPAQUE_CORE_PROOF_DOMAIN,
    response.version,
    response.callerPubkey,
    response.relayPubkey,
    response.coreKey,
    response.fork,
    response.observedLength,
    response.contiguousLength,
    response.index,
    response.nonce,
    response.minLength,
    response.blockHash,
    response.contentProofHash
  ]), 'utf8')
}

export async function verifyOpaqueCoreAvailabilityProof ({
  response,
  challenge,
  relayPubkey,
  callerPubkey = null,
  verifierCore = null
} = {}) {
  if (!response || response.ok !== true || response.code !== 'PROVED') return false
  if (!challenge || typeof challenge !== 'object') return false

  const expectedRelay = normalizeHex(relayPubkey)
  const expectedCaller = callerPubkey == null ? null : normalizeHex(callerPubkey)
  if (!HEX64.test(expectedRelay)) return false
  if (response.version !== OPAQUE_CORE_PROTOCOL_VERSION) return false
  if (response.coreKey !== normalizeHex(challenge.coreKey)) return false
  if (response.index !== challenge.index) return false
  if (response.nonce !== normalizeHex(challenge.nonce)) return false
  if (response.minLength !== (challenge.minLength ?? 0)) return false
  if (response.relayPubkey !== expectedRelay) return false
  if (expectedCaller && response.callerPubkey !== expectedCaller) return false
  if (!HEX64.test(response.callerPubkey || '')) return false
  if (!HEX64.test(response.blockHash || '') || !HEX64.test(response.contentProofHash || '')) return false
  if (!HEX128.test(response.signature || '')) return false
  if (!Number.isSafeInteger(response.fork) || response.fork < 0) return false
  if (!Number.isSafeInteger(response.observedLength) || response.observedLength < 0) return false
  if (!Number.isSafeInteger(response.contiguousLength) || response.contiguousLength < 0) return false
  if (response.observedLength < response.minLength || response.contiguousLength <= response.index) return false

  let block
  try { block = b4a.from(response.block || '', 'hex') } catch { return false }
  const blockHash = hashBytes(block)
  if (b4a.toString(blockHash, 'hex') !== response.blockHash) return false

  const contentProofHash = hashBytes(b4a.from(canonicalJson(response.contentProof), 'utf8'))
  if (b4a.toString(contentProofHash, 'hex') !== response.contentProofHash) return false

  const signatureValid = sodium.crypto_sign_verify_detached(
    b4a.from(response.signature, 'hex'),
    opaqueCoreProofBytes(response),
    b4a.from(expectedRelay, 'hex')
  )
  if (!signatureValid) return false

  if (verifierCore) {
    if (!response.contentProof) return false
    const verified = await verifyStorageProof({
      verifierCore,
      response: response.contentProof,
      expect: {
        driveKey: response.coreKey,
        index: response.index,
        nonce: response.nonce,
        relayPubkey: expectedRelay,
        minLength: response.minLength
      }
    })
    if (!verified.valid) return false
  }

  return response.proofLimit === RETRIEVABILITY_PROOF_LIMITATION &&
    response.signatureProfile === RETRIEVABILITY_PROOF_SIGNATURE_PROFILE
}

export function hashOpaqueCoreProof (value) {
  return b4a.toString(hashBytes(b4a.from(canonicalJson(value), 'utf8')), 'hex')
}

function registrationBytes (request) {
  return b4a.from(JSON.stringify([
    OPAQUE_CORE_REGISTER_DOMAIN,
    request.version,
    normalizeHex(request.coreKey),
    normalizeHex(request.nonce),
    request.expiresAt,
    normalizeHex(request.callerPubkey)
  ]), 'utf8')
}

function hashBytes (value) {
  const digest = b4a.alloc(32)
  sodium.crypto_generichash(digest, value)
  return digest
}

function canonicalJson (value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function normalizeHex (value) {
  if (typeof value === 'string') return value.toLowerCase()
  if (value && typeof value.byteLength === 'number') return b4a.toString(value, 'hex')
  return ''
}

