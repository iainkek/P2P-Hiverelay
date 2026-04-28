/**
 * HiveWormService — relay-side coordinator for hiveworm biomes.
 *
 * Each biome is identified by a 32-byte key (hex). The service holds:
 *   - The autobase log of entries for each biome (in-memory + persisted)
 *   - The derived WorldState per biome
 *   - WebSocket subscribers per biome
 *
 * It exposes methods used by the HTTP API:
 *   appendMove(biomeKey, entry)         POST /api/hiveworm/<biome>/move
 *   getState(biomeKey)                  GET  /api/hiveworm/<biome>/state
 *   getLog(biomeKey, fromIndex)         GET  /api/hiveworm/<biome>/log
 *   subscribe(biomeKey, callback)       WS   /api/hiveworm/<biome>/events
 *
 * Persistence is intentionally simple for v1: per-biome JSON-lines file.
 * In v2 we'll back this with the existing Hyperdrive seeding pipeline so
 * biomes anchor across relays.
 */

import { EventEmitter } from 'events'
import { readFile, mkdir, appendFile } from 'fs/promises'
import { join, dirname } from 'path'
import { deriveState, validateForAppend } from './index.js'

const MAX_LOG_BYTES = 50 * 1024 * 1024 // 50MB per biome — v1 cap
const MAX_BIOMES = 64 // soft cap per relay

export class HiveWormService extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.storage - directory under which biome logs are persisted
   */
  constructor (opts = {}) {
    super()
    this.storage = opts.storage || './hiveworm-data'
    this.biomes = new Map() // biomeKey -> { entries, state, lastSavedIdx, subscribers }
    this._saveDebounce = new Map() // biomeKey -> timer
  }

  /**
   * Load any persisted biome logs from disk on startup.
   */
  async start () {
    try {
      await mkdir(this.storage, { recursive: true })
    } catch (_) {}
    // Lazy-load biomes on demand instead of scanning the whole dir;
    // each ensureBiome() call reads the per-biome file.
  }

  async stop () {
    for (const [, t] of this._saveDebounce) clearTimeout(t)
    this._saveDebounce.clear()
    // Flush any pending writes
    for (const [biomeKey] of this.biomes) {
      await this._flushBiome(biomeKey).catch(() => {})
    }
  }

  // ─── Biome lifecycle ────────────────────────────────────────

  async ensureBiome (biomeKey) {
    if (this.biomes.has(biomeKey)) return this.biomes.get(biomeKey)
    if (this.biomes.size >= MAX_BIOMES) {
      throw new Error('BIOME_LIMIT: relay has reached its biome cap')
    }

    // Try to load existing log from disk
    const filePath = this._biomeLogPath(biomeKey)
    let entries = []
    try {
      const raw = await readFile(filePath, 'utf-8')
      entries = raw
        .split('\n')
        .filter(Boolean)
        .map(l => {
          try { return JSON.parse(l) } catch { return null }
        })
        .filter(Boolean)
    } catch (_) {
      // No log yet — fresh biome
    }

    const { state } = deriveState(entries)
    const biome = {
      key: biomeKey,
      entries,
      state,
      subscribers: new Set(),
      lastSavedIdx: entries.length
    }
    this.biomes.set(biomeKey, biome)
    return biome
  }

  // ─── Append + validate ─────────────────────────────────────

  /**
   * Validate + append a signed entry to the biome's log.
   * Returns { ok: true, index, state } on success or
   * { ok: false, reason, layer } on rejection.
   */
  async appendMove (biomeKey, entry) {
    const biome = await this.ensureBiome(biomeKey)

    // Cross-check biome field
    if (entry.biome !== biomeKey) {
      return { ok: false, reason: 'biome-mismatch', layer: 'preflight' }
    }

    const v = validateForAppend(entry, biome.state)
    if (!v.ok) return v

    // Apply optimistically by re-deriving with this entry appended.
    // Cheap for small logs; at scale we'd apply incrementally.
    biome.entries.push(entry)
    const { state, accepted } = deriveState(biome.entries)
    biome.state = state

    // If our entry was rejected during full re-derive (e.g. concurrent
    // appender beat us to a cell), revert. validateForAppend gave us
    // optimistic permission but state can still race.
    const ok = accepted.includes(entry.nonce)
    if (!ok) {
      biome.entries.pop()
      return { ok: false, reason: 'race-lost', layer: 'derive' }
    }

    this._scheduleSave(biomeKey)
    this._broadcast(biome, entry)

    return { ok: true, index: biome.entries.length - 1, state: state.toJSON() }
  }

  // ─── Read paths ────────────────────────────────────────────

  async getState (biomeKey) {
    const biome = await this.ensureBiome(biomeKey)
    return biome.state.toJSON()
  }

  async getLog (biomeKey, fromIndex = 0) {
    const biome = await this.ensureBiome(biomeKey)
    const idx = Math.max(0, Math.min(fromIndex, biome.entries.length))
    return {
      from: idx,
      total: biome.entries.length,
      entries: biome.entries.slice(idx)
    }
  }

  // ─── Subscription ──────────────────────────────────────────

  subscribe (biomeKey, callback) {
    const biome = this.biomes.get(biomeKey) || null
    if (!biome) return () => {}
    biome.subscribers.add(callback)
    return () => biome.subscribers.delete(callback)
  }

  _broadcast (biome, entry) {
    for (const fn of biome.subscribers) {
      try { fn(entry) } catch (_) { /* swallow */ }
    }
  }

  // ─── Persistence ───────────────────────────────────────────

  _biomeLogPath (biomeKey) {
    return join(this.storage, biomeKey.slice(0, 2), biomeKey + '.jsonl')
  }

  _scheduleSave (biomeKey) {
    if (this._saveDebounce.has(biomeKey)) return
    const t = setTimeout(() => {
      this._saveDebounce.delete(biomeKey)
      this._flushBiome(biomeKey).catch((err) => {
        this.emit('error', { context: 'flush', biomeKey, error: err })
      })
    }, 1000)
    if (t.unref) t.unref()
    this._saveDebounce.set(biomeKey, t)
  }

  async _flushBiome (biomeKey) {
    const biome = this.biomes.get(biomeKey)
    if (!biome) return
    if (biome.entries.length === biome.lastSavedIdx) return

    const filePath = this._biomeLogPath(biomeKey)
    await mkdir(dirname(filePath), { recursive: true }).catch(() => {})

    // Append-only: write entries since lastSavedIdx
    const newSlice = biome.entries.slice(biome.lastSavedIdx)
    const lines = newSlice.map(e => JSON.stringify(e)).join('\n') + '\n'

    // Cap log size — if exceeded, refuse to write more (operators can
    // tune; v1 just protects the disk)
    if (lines.length > MAX_LOG_BYTES) {
      this.emit('error', { context: 'log-too-large', biomeKey })
      return
    }

    await appendFile(filePath, lines, 'utf-8')
    biome.lastSavedIdx = biome.entries.length
  }

  // ─── Stats ─────────────────────────────────────────────────

  stats () {
    const out = []
    for (const [key, b] of this.biomes) {
      out.push({
        biomeKey: key,
        tick: b.state.tick,
        worms: b.state.worms.size,
        food: b.state.food.size,
        entries: b.entries.length,
        subscribers: b.subscribers.size
      })
    }
    return out
  }
}
