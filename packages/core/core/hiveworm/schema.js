/**
 * HiveWorm — entry schemas for the per-biome autobase log.
 *
 * Every game-affecting action is a signed entry in the biome's autobase.
 * The world state is derived deterministically by replaying entries in
 * order. Invalid entries (bad signature, illegal move, expired tick) are
 * skipped at derivation time.
 *
 * All entries share a base envelope:
 *   {
 *     schema: 'hiveworm/<kind>/v1',
 *     worm:   <pubkey-hex>,        // who signed this
 *     biome:  <biome-key-hex>,     // biome scope (replay protection)
 *     ts:     <unix-ms>,           // signed-at clock
 *     nonce:  <16-hex bytes>,      // dedup
 *     ...kind-specific fields,
 *     signature: <128-hex bytes>   // ed25519(payload, sk(worm))
 *   }
 *
 * Signature covers JSON.stringify(everything except `signature`). The
 * relay re-serializes deterministically before verifying.
 */

import b4a from 'b4a'

const PUBKEY_HEX_RE = /^[0-9a-f]{64}$/
const SIG_HEX_RE = /^[0-9a-f]{128}$/
const NONCE_HEX_RE = /^[0-9a-f]{32}$/

export const SCHEMAS = {
  BIOME_INIT: 'hiveworm/biome-init/v1', // creator stamp + config
  SPAWN: 'hiveworm/spawn/v1', // bring a new worm into the world
  MOVE: 'hiveworm/move/v1', // step a worm by one cell
  DEATH: 'hiveworm/death/v1', // collision; emitted by deriver, not players
  MEMORIAL: 'hiveworm/memorial/v1' // optional epitaph at death site
}

export const DIRECTIONS = ['N', 'S', 'E', 'W']

export const DEFAULT_BIOME_CONFIG = {
  width: 200,
  height: 200,
  // Cooldown between consecutive moves by the same worm (ms).
  // Acts as the rate-limit substitute for the dropped Lightning per-tick fee.
  moveCooldownMs: 5000,
  // Initial worm length on spawn
  spawnLength: 3,
  // How many food dots the world sustains
  targetFoodCount: 50,
  // Food spawn seed — same biome, same food layout (deterministic)
  foodSeed: '0000000000000000000000000000000000000000000000000000000000000000'
}

// ─── Validation helpers ─────────────────────────────────────────

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

/**
 * Canonicalize an entry for signing/verification. Sorts keys, drops
 * `signature`, returns a deterministic JSON string.
 */
export function canonicalPayload (entry) {
  const copy = { ...entry }
  delete copy.signature
  // Stable key order via JSON-stringify with sorted keys
  const sortedKeys = Object.keys(copy).sort()
  const ordered = {}
  for (const k of sortedKeys) ordered[k] = copy[k]
  return Buffer.from(JSON.stringify(ordered), 'utf-8')
}

/**
 * Shared envelope checks. Returns null if valid, else a string reason.
 */
export function checkEnvelope (entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return 'not-an-object'
  if (typeof entry.schema !== 'string') return 'missing-schema'
  if (!isValidPubkey(entry.worm)) return 'bad-worm-pubkey'
  if (!isValidBiomeKey(entry.biome)) return 'bad-biome-key'
  if (!Number.isInteger(entry.ts)) return 'bad-ts'
  if (!isValidNonce(entry.nonce)) return 'bad-nonce'
  if (!isValidSignature(entry.signature)) return 'bad-signature'

  // Reject far-future and very-stale timestamps to bound the dedup
  // nonce cache size.
  const now = opts.now || Date.now()
  const driftFutureMs = opts.driftFutureMs || 60_000
  const driftPastMs = opts.driftPastMs || 5 * 60_000
  if (entry.ts > now + driftFutureMs) return 'ts-future'
  if (entry.ts < now - driftPastMs) return 'ts-stale'

  return null
}

/**
 * Schema-specific shape checks. Envelope is assumed valid.
 */
export function checkShape (entry) {
  switch (entry.schema) {
    case SCHEMAS.BIOME_INIT: {
      if (typeof entry.config !== 'object' || entry.config === null) return 'missing-config'
      const c = entry.config
      if (!Number.isInteger(c.width) || c.width <= 0) return 'bad-width'
      if (!Number.isInteger(c.height) || c.height <= 0) return 'bad-height'
      return null
    }
    case SCHEMAS.SPAWN: {
      if (!Array.isArray(entry.atPos) || entry.atPos.length !== 2) return 'bad-atPos'
      if (!Number.isInteger(entry.atPos[0]) || !Number.isInteger(entry.atPos[1])) return 'bad-atPos-int'
      return null
    }
    case SCHEMAS.MOVE: {
      if (!isValidDirection(entry.direction)) return 'bad-direction'
      return null
    }
    case SCHEMAS.MEMORIAL: {
      if (typeof entry.epitaph !== 'string' || entry.epitaph.length > 280) return 'bad-epitaph'
      return null
    }
    case SCHEMAS.DEATH:
      // Death entries are emitted by the deriver, not players. If we see
      // one in the log we trust it (it'll be re-derived if invalid).
      return null
    default:
      return 'unknown-schema'
  }
}

export function isPlayerEntry (entry) {
  return entry && entry.schema !== SCHEMAS.DEATH
}

// Helpers exported for the client SDK + tests
export const _b4a = b4a
