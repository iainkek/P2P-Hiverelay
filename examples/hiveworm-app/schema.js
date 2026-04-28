// HiveWorm — entry schemas, ported from packages/core/core/hiveworm/schema.js
//
// This file MUST stay byte-compatible with the relay's schema.js. The
// canonical signing format (sorted-keys JSON.stringify of payload sans
// signature) is what the relay verifies, so any drift here breaks signing.

export const SCHEMAS = {
  BIOME_INIT: 'hiveworm/biome-init/v1',
  SPAWN: 'hiveworm/spawn/v1',
  MOVE: 'hiveworm/move/v1',
  DEATH: 'hiveworm/death/v1',
  MEMORIAL: 'hiveworm/memorial/v1'
}

export const DIRECTIONS = ['N', 'S', 'E', 'W']

const PUBKEY_HEX_RE = /^[0-9a-f]{64}$/
const SIG_HEX_RE = /^[0-9a-f]{128}$/
const NONCE_HEX_RE = /^[0-9a-f]{32}$/

export function isValidPubkey (s) {
  return typeof s === 'string' && PUBKEY_HEX_RE.test(s)
}
export function isValidSignature (s) {
  return typeof s === 'string' && SIG_HEX_RE.test(s)
}
export function isValidNonce (s) {
  return typeof s === 'string' && NONCE_HEX_RE.test(s)
}
export function isValidDirection (d) {
  return typeof d === 'string' && DIRECTIONS.includes(d)
}
export function isValidBiomeKey (s) {
  return typeof s === 'string' && PUBKEY_HEX_RE.test(s)
}

// Direction → unit vector. Matches WorldState.dirVec on the relay.
export const DIR_VEC = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0]
}

/**
 * Canonicalize an entry for signing/verification.
 *
 * Sorts top-level keys, drops `signature`, JSON.stringify with that
 * order, then UTF-8 encode to bytes. The relay does the same on its
 * side using b4a.from(JSON.stringify(...), 'utf-8').
 *
 * Returns Uint8Array.
 */
export function canonicalPayload (entry) {
  const copy = { ...entry }
  delete copy.signature
  const sortedKeys = Object.keys(copy).sort()
  const ordered = {}
  for (const k of sortedKeys) ordered[k] = copy[k]
  return new TextEncoder().encode(JSON.stringify(ordered))
}

// ─── Hex helpers ──────────────────────────────────────────────

export function bytesToHex (u8) {
  let s = ''
  for (let i = 0; i < u8.length; i++) {
    s += u8[i].toString(16).padStart(2, '0')
  }
  return s
}

export function hexToBytes (hex) {
  if (typeof hex !== 'string') throw new TypeError('hex must be a string')
  if (hex.length % 2 !== 0) throw new RangeError('hex string odd length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * 16 random bytes → 32-char hex. Used as the entry nonce. The browser
 * has crypto.getRandomValues so this is safe for replay protection.
 */
export function randomNonce () {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return bytesToHex(buf)
}
