/**
 * Anchor proof verification.
 *
 * Verifies signed `/api/anchors/<appKey>/proof` payloads emitted by relays.
 * Used by AutoHeal (and any third-party verifier) to count a peer as a
 * live replica only if they cryptographically demonstrate they have the
 * drive's content, instead of trusting the self-reported `anchored: true`
 * bit on a federation catalog entry.
 *
 * The signed payload format mirrors the api.js producer:
 *
 *   tag(`hiverelay-anchor-proof-v1`) ||
 *   appKey(32 bytes) ||
 *   version(uint64 BE) ||
 *   attestedAt(uint64 BE) ||
 *   anchored(uint8: 1=anchored, 0=not anchored)
 *
 * Signed with the relay's identity Ed25519 secretKey (`swarm.keyPair`).
 *
 * The verifier checks:
 *   1. Schema fields present and correctly typed
 *   2. Signature is valid against the claimed relayPubkey
 *   3. The pubkey actually matches the publisher of the proof (out-of-band
 *      check — caller passes expectedPubkey to pin against MITM)
 *
 * Optional staleness check: callers can pass `freshnessMs` and we'll
 * reject proofs older than that window. Defaults to no freshness check —
 * caller decides.
 */

import sodium from 'sodium-universal'
import b4a from 'b4a'

const TAG = b4a.from('hiverelay-anchor-proof-v1')

/**
 * Verify a fetched anchor proof. Returns:
 *   { ok: true, proof }       on success
 *   { ok: false, reason }     on any failure
 *
 * @param {object} proof Output of GET /api/anchors/<appKey>/proof
 * @param {object} opts
 * @param {string} [opts.expectedAppKey] - if set, proof.appKey must match
 * @param {string} [opts.expectedPubkey] - if set, proof.relayPubkey must match
 * @param {number} [opts.freshnessMs]    - if set, attestedAt must be within window
 * @param {number} [opts.maxClockSkewMs] - default 60s; attestedAt cannot exceed now+skew
 */
export function verifyAnchorProof (proof, opts = {}) {
  if (!proof || typeof proof !== 'object') return { ok: false, reason: 'missing-proof' }

  const required = ['appKey', 'anchored', 'version', 'attestedAt', 'relayPubkey', 'signature']
  for (const key of required) {
    if (proof[key] === undefined || proof[key] === null) {
      return { ok: false, reason: `missing-field:${key}` }
    }
  }

  if (typeof proof.appKey !== 'string' || proof.appKey.length !== 64) {
    return { ok: false, reason: 'bad-appkey' }
  }
  if (typeof proof.relayPubkey !== 'string' || proof.relayPubkey.length !== 64) {
    return { ok: false, reason: 'bad-relaypubkey' }
  }
  if (typeof proof.signature !== 'string' || proof.signature.length !== 128) {
    return { ok: false, reason: 'bad-signature' }
  }
  if (typeof proof.version !== 'number' || proof.version < 0) {
    return { ok: false, reason: 'bad-version' }
  }
  if (typeof proof.attestedAt !== 'number' || proof.attestedAt <= 0) {
    return { ok: false, reason: 'bad-attestedat' }
  }
  if (typeof proof.anchored !== 'boolean') {
    return { ok: false, reason: 'bad-anchored' }
  }

  if (opts.expectedAppKey && proof.appKey.toLowerCase() !== opts.expectedAppKey.toLowerCase()) {
    return { ok: false, reason: 'appkey-mismatch' }
  }
  if (opts.expectedPubkey && proof.relayPubkey.toLowerCase() !== opts.expectedPubkey.toLowerCase()) {
    return { ok: false, reason: 'pubkey-mismatch' }
  }

  // Clock skew: a proof claiming to be from 5min in the future is suspect
  const skew = opts.maxClockSkewMs ?? 60_000
  if (proof.attestedAt > Date.now() + skew) {
    return { ok: false, reason: 'future-timestamp' }
  }

  // Freshness: reject proofs older than the window
  if (opts.freshnessMs && (Date.now() - proof.attestedAt) > opts.freshnessMs) {
    return { ok: false, reason: 'stale' }
  }

  // Verify the Ed25519 signature
  try {
    const keyBuf = b4a.from(proof.appKey, 'hex')
    const versionBuf = b4a.alloc(8)
    new DataView(versionBuf.buffer, versionBuf.byteOffset).setBigUint64(0, BigInt(proof.version), false)
    const tsBuf = b4a.alloc(8)
    new DataView(tsBuf.buffer, tsBuf.byteOffset).setBigUint64(0, BigInt(proof.attestedAt), false)
    const flagBuf = b4a.from([proof.anchored ? 1 : 0])
    const payload = b4a.concat([TAG, keyBuf, versionBuf, tsBuf, flagBuf])
    const sig = b4a.from(proof.signature, 'hex')
    const pub = b4a.from(proof.relayPubkey, 'hex')

    if (!sodium.crypto_sign_verify_detached(sig, payload, pub)) {
      return { ok: false, reason: 'bad-signature-cryptographic' }
    }
  } catch (err) {
    return { ok: false, reason: 'verify-error:' + err.message }
  }

  return { ok: true, proof }
}

/**
 * Convenience: fetch a peer's anchor proof and verify it.
 *
 * @param {string} peerUrl  - e.g. 'https://relay-us.example.com:9100'
 * @param {string} appKey   - hex-encoded
 * @param {object} opts     - same as verifyAnchorProof opts; also fetchTimeoutMs
 * @returns {Promise<{ ok, proof?, reason?, fetchedAt? }>}
 */
export async function fetchAndVerifyAnchorProof (peerUrl, appKey, opts = {}) {
  const url = peerUrl.replace(/\/$/, '') + '/api/anchors/' + encodeURIComponent(appKey) + '/proof'
  const timeoutMs = opts.fetchTimeoutMs ?? 5000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (timer.unref) timer.unref()
  let body = null
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      return { ok: false, reason: `http-${res.status}` }
    }
    body = await res.json()
  } catch (err) {
    return { ok: false, reason: 'fetch-error:' + (err.message || 'unknown') }
  } finally {
    clearTimeout(timer)
  }

  const result = verifyAnchorProof(body, { ...opts, expectedAppKey: appKey })
  if (result.ok) result.fetchedAt = Date.now()
  return result
}
