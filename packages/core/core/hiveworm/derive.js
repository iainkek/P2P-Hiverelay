/**
 * HiveWorm — state deriver.
 *
 * Pure function: deriveState(entries, opts) -> WorldState
 *
 * Replays signed entries in autobase order. Skips entries that fail
 * preflight (bad signature, wrong shape) so the world state is robust
 * against garbage entries that snuck past the relay's append-time
 * checks.
 *
 * Game rule reduction:
 *   - SPAWN: places the worm with `spawnLength` segments at atPos
 *   - MOVE: advances the head; if cell has food, eats and grows;
 *     if cell has another worm, the moving worm dies (collision);
 *     otherwise, normal step (grow head, drop tail)
 *   - MEMORIAL: appended to the worm's death record
 *
 * Death entries in the log are advisory only — the deriver re-derives
 * deaths from MOVE collisions deterministically.
 */

import { WorldState } from './state.js'
import { preflightEntry, validateAgainstState } from './validate.js'
import { SCHEMAS } from './schema.js'

const DEFAULT_LIMIT = 1_000_000 // safety cap on entries replayed

export function deriveState (entries, opts = {}) {
  const limit = opts.limit || DEFAULT_LIMIT
  const skipped = []
  const accepted = []

  // Find the BIOME_INIT entry to seed config (first one wins; later
  // ones rejected by validateAgainstState's biome-init-too-late check)
  let initConfig = null
  for (const e of entries) {
    if (e?.schema === SCHEMAS.BIOME_INIT) {
      const reason = preflightEntry(e, opts)
      if (!reason) {
        initConfig = e.config
        break
      }
    }
  }

  const state = new WorldState(initConfig || {})
  if (initConfig) {
    // Mark init's nonce so it can't be replayed
    // (we'll replay it below to record the accepted entry)
  }

  let processed = 0
  for (const entry of entries) {
    if (processed >= limit) break
    processed++

    // Preflight rejects garbage early
    const pre = preflightEntry(entry, opts)
    if (pre) {
      skipped.push({ nonce: entry?.nonce || null, reason: pre, layer: 'preflight' })
      continue
    }

    // Game-rule check
    const reason = validateAgainstState(entry, state)
    if (reason) {
      skipped.push({ nonce: entry.nonce, reason, layer: 'game-rule' })
      continue
    }

    // Apply
    applyEntry(entry, state)
    state.processedNonces.add(entry.nonce)
    accepted.push(entry.nonce)
  }

  return { state, accepted, skipped }
}

function applyEntry (entry, state) {
  switch (entry.schema) {
    case SCHEMAS.BIOME_INIT:
      // Config already loaded; this entry just gets recorded as processed
      return

    case SCHEMAS.SPAWN: {
      const [x, y] = entry.atPos
      // Place worm with spawnLength segments stacked on the spawn cell.
      // The worm's first move will spread the body out naturally.
      const segments = []
      for (let i = 0; i < state.config.spawnLength; i++) {
        segments.push([x, y])
      }
      state.worms.set(entry.worm, {
        pubkey: entry.worm,
        segments,
        length: state.config.spawnLength,
        alive: true,
        lastMoveTs: 0,
        bornAt: entry.ts
      })
      return
    }

    case SCHEMAS.MOVE: {
      const worm = state.worms.get(entry.worm)
      if (!worm || !worm.alive) return

      const head = worm.segments[0]
      const dv = WorldState.dirVec(entry.direction)
      const [nx, ny] = [head[0] + dv[0], head[1] + dv[1]]

      // Check for food at target cell
      const foodKey = state.cellKey(nx, ny)
      const foodHere = state.food.get(foodKey)

      // Check for collision with another worm
      const occupant = state.occupant(nx, ny)
      const collidedWith = occupant && occupant !== entry.worm ? occupant : null

      // Move the worm: prepend new head; only drop tail if NOT eating
      worm.segments.unshift([nx, ny])
      if (!foodHere) {
        worm.segments.pop()
      } else {
        worm.length += foodHere.value
        state.food.delete(foodKey)
      }
      worm.lastMoveTs = entry.ts

      if (collidedWith) {
        // Moving worm dies; collided-into worm gets the food.
        // Drop the dead worm's segments as food dots.
        worm.alive = false
        for (const [sx, sy] of worm.segments) {
          if (state.inBounds(sx, sy)) {
            state.food.set(state.cellKey(sx, sy), { x: sx, y: sy, value: 1 })
          }
        }
        state.deaths.push({
          pubkey: entry.worm,
          atPos: [nx, ny],
          byPubkey: collidedWith,
          atTick: state.tick
        })
      }

      // Replenish food deterministically when we drop below target
      state._replenishFood(state.tick)
      state.tick++
      return
    }

    case SCHEMAS.MEMORIAL: {
      state.memorials.push({
        pubkey: entry.worm,
        atPos: state.deaths.find(d => d.pubkey === entry.worm)?.atPos || null,
        epitaph: entry.epitaph,
        atTick: state.tick
      })
      break
    }

    case SCHEMAS.DEATH:
      // Deriver-only schema — no-op (real deaths handled in MOVE)
      break
  }
}
