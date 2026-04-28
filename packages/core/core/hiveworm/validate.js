/**
 * HiveWorm — entry validation.
 *
 * Two layers:
 *   verifySignature(entry)          cryptographic validity (Ed25519)
 *   validateAgainstState(entry, state)  game-rule legality
 *
 * The relay's POST /api/hiveworm/<biome>/move endpoint runs both before
 * appending to the autobase. Invalid entries are rejected with 422
 * + reason so the client can show immediate feedback.
 *
 * The deriver also runs validateAgainstState during replay to defend
 * against the case where a relay accepted an entry that was valid at
 * append-time but is no longer valid by the time it lands in the log
 * (race conditions across multiple appenders).
 */

import sodium from 'sodium-universal'
import b4a from 'b4a'
import { canonicalPayload, SCHEMAS, checkEnvelope, checkShape } from './schema.js'
import { WorldState } from './state.js'

/**
 * Verify the Ed25519 signature on an entry.
 * Returns null if valid, else a string reason.
 */
export function verifySignature (entry) {
  try {
    const payload = canonicalPayload(entry)
    const sig = b4a.from(entry.signature, 'hex')
    const pk = b4a.from(entry.worm, 'hex')
    if (sig.length !== sodium.crypto_sign_BYTES) return 'sig-bad-length'
    if (pk.length !== sodium.crypto_sign_PUBLICKEYBYTES) return 'pk-bad-length'
    const ok = sodium.crypto_sign_verify_detached(sig, payload, pk)
    return ok ? null : 'sig-invalid'
  } catch (err) {
    return 'sig-verify-error'
  }
}

/**
 * Pre-flight checks before consulting WorldState. Combines envelope +
 * shape + signature.
 */
export function preflightEntry (entry, opts = {}) {
  const env = checkEnvelope(entry, opts)
  if (env) return env
  const shape = checkShape(entry)
  if (shape) return shape
  const sig = verifySignature(entry)
  if (sig) return sig
  return null
}

/**
 * Validate an entry against the current WorldState. Returns null if
 * legal, else a string reason. Pure function — does NOT mutate state.
 *
 * Pre-condition: preflightEntry(entry) returned null.
 */
export function validateAgainstState (entry, state) {
  if (!(state instanceof WorldState)) return 'no-state'

  // Replay protection: nonce already processed
  if (state.processedNonces.has(entry.nonce)) return 'nonce-replayed'

  switch (entry.schema) {
    case SCHEMAS.BIOME_INIT:
      // Init can only appear once at tick 0 — i.e., when the world has
      // no worms yet AND no deaths AND tick === 0.
      if (state.worms.size > 0 || state.deaths.length > 0 || state.tick > 0) {
        return 'biome-init-too-late'
      }
      return null

    case SCHEMAS.SPAWN: {
      // Already alive?
      const existing = state.worms.get(entry.worm)
      if (existing && existing.alive) return 'already-alive'

      const [x, y] = entry.atPos
      if (!state.inBounds(x, y)) return 'spawn-out-of-bounds'
      if (state.occupant(x, y)) return 'spawn-occupied'
      return null
    }

    case SCHEMAS.MOVE: {
      const worm = state.worms.get(entry.worm)
      if (!worm) return 'worm-not-spawned'
      if (!worm.alive) return 'worm-dead'

      // Cooldown gate (rate-limit substitute for the dropped LN per-tick fee)
      if (worm.lastMoveTs && (entry.ts - worm.lastMoveTs) < state.config.moveCooldownMs) {
        return 'move-cooldown'
      }

      const head = worm.segments[0]
      const dv = WorldState.dirVec(entry.direction)
      const [nx, ny] = [head[0] + dv[0], head[1] + dv[1]]

      if (!state.inBounds(nx, ny)) return 'move-out-of-bounds'

      // Self-collision: can't move into your own body (except tail tip,
      // which is about to vacate)
      const tailTip = worm.segments[worm.segments.length - 1]
      for (let i = 0; i < worm.segments.length; i++) {
        const [sx, sy] = worm.segments[i]
        if (sx === nx && sy === ny) {
          // The tail-tip is leaving as we move forward — allow it
          if (sx === tailTip[0] && sy === tailTip[1]) continue
          return 'move-self-collision'
        }
      }

      // Other-worm collision is allowed at validate time — collision is
      // resolved by the deriver (the moving worm dies, collided-into one
      // gets food). We only block if BOTH worms in question would die
      // simultaneously into walls (caught by inBounds above).

      return null
    }

    case SCHEMAS.MEMORIAL: {
      // Must reference the worm's own death
      const owners = state.deaths.filter(d => d.pubkey === entry.worm)
      if (owners.length === 0) return 'memorial-without-death'
      return null
    }

    case SCHEMAS.DEATH:
      // Player can't submit DEATH directly; deriver-only schema
      return 'death-not-submittable'

    default:
      return 'unknown-schema'
  }
}

/**
 * Convenience: full validation pipeline for the move endpoint.
 * Returns { ok: true } | { ok: false, reason: string }.
 */
export function validateForAppend (entry, state, opts = {}) {
  const preflight = preflightEntry(entry, opts)
  if (preflight) return { ok: false, reason: preflight, layer: 'preflight' }
  const game = validateAgainstState(entry, state)
  if (game) return { ok: false, reason: game, layer: 'game-rule' }
  return { ok: true }
}
