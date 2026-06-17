/**
 * Hypercore-backed persistence for PokerApp.
 *
 * Wraps a PokerApp so that every successfully-appended SignedLog entry is
 * also appended to a per-table Hypercore. On startup, the adapter rehydrates
 * each table's in-memory SignedLog from its Hypercore's blocks.
 *
 * ─── Why a hypercore (and not raw files)? ──────────────────────────────────
 *
 * Three things drop out for free once entries live in a Hypercore:
 *
 *   1. The relay's existing seeder / federation / custody-pipeline picks up
 *      the core via its key. No extra plumbing.
 *   2. The cancellation-contract (reliability v2) guarantees apply — a
 *      relay claiming to pin a table's history can't lie about it.
 *   3. Cross-relay replication is the same code path used for every other
 *      seeded core, including the partial-pin auto-heal work.
 *
 * ─── Storage layout ────────────────────────────────────────────────────────
 *
 * One hypercore per table, accessed via the corestore namespace:
 *
 *   store.get({ name: 'poker/<tableKey>' })
 *
 * Each block is a single signed entry, JSON-encoded as utf-8. We don't use
 * any binary framing on top — the SignedLog format already covers
 * everything the relay needs and JSON keeps debugging trivial.
 *
 * ─── Table provisioning ────────────────────────────────────────────────────
 *
 *   await persistence.createPersistentTable({ tableKey, writers, options })
 *
 * If a backing hypercore exists, its blocks are replayed into a fresh
 * SignedLog via PokerApp.replayEntries (which calls SignedLog._replay —
 * the trust-at-hydrate path). New entries then go through the normal
 * cryptographic check before being appended both to the in-memory log
 * and to the core. We never bypass validation on the live path — only
 * on the rehydrate-from-store path, and the store IS our own append
 * sink, so the entries it returns are entries we ourselves accepted.
 *
 * ─── What this is NOT ──────────────────────────────────────────────────────
 *
 * Not autobase. Not multi-writer in the corestore sense — one core per
 * table, the relay is the only one appending. The "multi-writer" property
 * of a poker table comes from multiple ed25519-signed entries within that
 * single linear core. (Autobase would be the right tool for a model where
 * every player has their own writer core and the table is a merge — that's
 * a bigger refactor for a follow-up.)
 *
 * ─── Failure modes ─────────────────────────────────────────────────────────
 *
 * If the core append fails after the in-memory append succeeded, the log is
 * ahead of disk. We emit a `mirror-error` event and continue — the in-memory
 * log is the source of truth for live play; missing-from-disk entries would
 * be re-published by clients on reconnect via re-submission (signed-log
 * idempotency: same writer + same seq = BAD_SEQ on the in-memory log so the
 * client knows it's already accepted, but the core append can be retried by
 * the operator's reconciliation pass — out of scope here).
 */

import { EventEmitter } from 'events'

const CORE_NAME_PREFIX = 'poker/'
const APPEND_TIMEOUT_MS = 5000

export class HypercorePersistence extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.pokerApp                A started PokerApp.
   * @param {object} opts.store                   A Corestore.
   * @param {(label, info) => void} [opts.log]    Optional logger.
   */
  constructor (opts) {
    super()
    if (!opts || !opts.pokerApp) throw new Error('HypercorePersistence: pokerApp required')
    if (!opts.store) throw new Error('HypercorePersistence: store required')
    this.pokerApp = opts.pokerApp
    this.store = opts.store
    // Phase 12 Wave 1: optional Seeder so each mirrored table-core is announced on the
    // DHT for cross-relay / peer availability. Without it, mirroring still gives
    // single-relay restart durability via rehydrateAll().
    this.seeder = opts.seeder || null
    // Set true to allow auto-mirroring of tables created via BOTH the HTTP adapter and
    // the P2P services-RPC path (default true — that is the point of this collaborator).
    this.autoMirror = opts.autoMirror !== false
    this._log = opts.log || (() => {})
    /** @type {Map<string, { core: object, unsub: () => void }>} */
    this._mirrors = new Map()
    /** @type {?object} append-only index core listing {tableKey,writers,options} per table. */
    this._indexCore = null
    /** While true, the create→_onTableCreated hook is suppressed (rehydrate drives attach itself). */
    this._rehydrating = false
    this._stopped = false

    // Phase 12 Wave 1: collaborator wiring. Every table PokerApp creates (HTTP or P2P)
    // is recorded in the index + mirrored + seeded — idempotently — unless we are mid-
    // rehydrate (that path creates + replays + attaches explicitly).
    if (this.autoMirror) {
      this.pokerApp._onTableCreated = (info) => {
        if (this._stopped || this._rehydrating || !info || !info.tableKey) return
        this._onLiveTableCreated(info).catch((err) => {
          this.emit('mirror-error', { tableKey: info.tableKey, error: err && err.message })
          this._log('auto-mirror-error', { tableKey: info.tableKey, error: err && err.message })
        })
      }
    }
  }

  /**
   * Returns the core for a given table key, opening it if needed.
   * Idempotent — same key returns the same core.
   *
   * @param {string} tableKey hex
   * @returns {Promise<object>} Hypercore instance (ready()-ed)
   */
  async _coreFor (tableKey) {
    const key = String(tableKey).toLowerCase()
    const existing = this._mirrors.get(key)
    if (existing) return existing.core
    const core = this.store.get({ name: CORE_NAME_PREFIX + key })
    await core.ready()
    return core
  }

  /**
   * Open a core for `tableKey`, replay its blocks into a freshly-created
   * PokerApp table, then wire forward mirroring so new appends are saved.
   *
   * Returns the PokerApp table descriptor.
   *
   * Throws if the table already exists in the PokerApp — call closeTable
   * first (or let the reaper handle it) before re-provisioning.
   *
   * @param {object} args
   * @param {string} args.tableKey
   * @param {string[]} args.writers
   * @param {object} [args.options]
   */
  async createPersistentTable (args, { skipIndex = false } = {}) {
    if (this._stopped) throw new Error('HypercorePersistence: stopped')
    const key = String(args.tableKey).toLowerCase()
    const core = await this._coreFor(key)

    // Create the in-memory table first so we have somewhere to replay into.
    // The PokerApp create-hook is suppressed during rehydrate (this._rehydrating);
    // for a direct live call the hook may also fire, but every step below is
    // idempotent (mirror keyed by tableKey, seedCore deduped, index deduped on read).
    const desc = this.pokerApp.createTable({
      tableKey: key,
      writers: args.writers,
      options: args.options
    })

    // Replay existing blocks. We deliberately read all at once — tables are
    // bounded in size by maxEntriesPerTable and this only runs at startup.
    //
    // Validate shape BEFORE handing to replayEntries. SignedLog._replay is
    // documented as the trust-at-hydrate path — it does NOT re-validate
    // signatures, but it DOES dereference entry.writer / entry.seq / entry.ts
    // directly. A JSON-valid block missing those fields would throw a raw
    // TypeError inside the SignedLog and leave the in-memory table in a
    // half-replayed state. We catch that here instead: any bad block aborts
    // the whole replay, closes the half-created table, and surfaces the
    // index of the offender so the operator can repair.
    const length = core.length
    if (length > 0) {
      const entries = []
      for (let i = 0; i < length; i++) {
        const block = await core.get(i)
        let parsed
        try {
          parsed = JSON.parse(block.toString('utf8'))
        } catch (err) {
          this.pokerApp.closeTable(key)
          throw new Error('HypercorePersistence: corrupt block ' + i + ': ' + err.message)
        }
        const shapeError = _validateReplayEntryShape(parsed)
        if (shapeError) {
          this.pokerApp.closeTable(key)
          throw new Error('HypercorePersistence: bad-shape block ' + i + ': ' + shapeError)
        }
        entries.push(parsed)
      }
      this.pokerApp.replayEntries(key, entries)
      this.emit('hydrated', { tableKey: key, count: entries.length })
    }

    // Wire forward mirroring + backfill + seed (via attach) + record in the index.
    await this.attach(key)
    if (!skipIndex) await this._appendIndex({ tableKey: key, writers: args.writers, options: args.options })
    return desc
  }

  // ─── Phase 12 Wave 1: auto-mirror + seed + restart-rehydrate ─────────────────

  /**
   * Live-path hook target: a table was just created on this relay (HTTP or P2P).
   * The in-memory table already exists and its backing core is (normally) empty,
   * so we only record it in the index, attach forward mirroring, and seed — no
   * replay. Idempotent.
   */
  async _onLiveTableCreated ({ tableKey, writers, options }) {
    if (this._stopped) return
    const key = String(tableKey).toLowerCase()
    await this._appendIndex({ tableKey: key, writers, options })
    await this.attach(key)
  }

  /**
   * Attach forward mirroring to an ALREADY-created table + seed its core.
   * Idempotent — a second call for the same table is a no-op. Does NOT replay
   * (live tables start empty; rehydrate replays before attaching).
   */
  async attach (tableKey) {
    if (this._stopped) return null
    const key = String(tableKey).toLowerCase()
    const core = await this._coreFor(key)
    // Subscribe FIRST (captures future appends), THEN backfill any entries that
    // already landed in the in-memory log before mirroring attached — the create-hook
    // is async, so a fast submitEntry can beat it. _mirror is index-guarded, so the
    // backfill and a racing live append can never double-write the same block.
    this._attachMirror(key, core)
    const view = this.pokerApp.getLog(key, core.length)
    if (view && Array.isArray(view.entries)) {
      let idx = (typeof view.from === 'number') ? view.from : core.length
      for (const entry of view.entries) {
        await this._mirror(key, core, entry, idx)
        idx++
      }
    }
    await this._seed(core)
    return core.key ? core.key.toString('hex') : null
  }

  /** Idempotent mirror wiring: subscribe in-memory appends → core.append. */
  _attachMirror (key, core) {
    if (this._mirrors.has(key)) return
    const unsub = this.pokerApp.subscribe(key, (entry, index) => {
      this._mirror(key, core, entry, index).catch((err) => {
        this.emit('mirror-error', { tableKey: key, error: err && err.message })
        this._log('mirror-error', { tableKey: key, error: err && err.message })
      })
    })
    this._mirrors.set(key, { core, unsub })
  }

  /** Best-effort DHT seeding of a table core (no-op without a seeder). */
  async _seed (core) {
    if (!this.seeder || !core || !core.key) return
    try {
      await this.seeder.seedCore(core.key.toString('hex'))
    } catch (err) {
      this._log('seed-error', { error: err && err.message })
    }
  }

  /** Open (once) the append-only table-index core used by rehydrateAll. */
  async _indexCoreReady () {
    if (this._indexCore) return this._indexCore
    const core = this.store.get({ name: CORE_NAME_PREFIX + '__index__' })
    await core.ready()
    this._indexCore = core
    return core
  }

  /** Append a table provisioning record so a relay restart can rehydrate it. */
  async _appendIndex ({ tableKey, writers, options }) {
    try {
      const core = await this._indexCoreReady()
      const rec = { tableKey: String(tableKey).toLowerCase(), writers: writers || [], options: options || {} }
      await core.append(Buffer.from(JSON.stringify(rec), 'utf8'))
    } catch (err) {
      this._log('index-append-error', { error: err && err.message })
    }
  }

  /**
   * Rebuild every previously-provisioned table from disk on relay startup, so an
   * in-flight hand survives a relay restart (the in-memory SignedLog is otherwise
   * lost on restart). Reads the index core, keeps the latest record per tableKey,
   * and createPersistentTable()s each (which replays its core blocks + re-attaches
   * + re-seeds). Idempotent: tables already present are skipped.
   *
   * @returns {Promise<{ rehydrated: number, tableKeys: string[] }>}
   */
  async rehydrateAll () {
    if (this._stopped) return { rehydrated: 0, tableKeys: [] }
    const core = await this._indexCoreReady()
    // Latest record per tableKey (last writer-set/options win).
    const latest = new Map()
    for (let i = 0; i < core.length; i++) {
      try {
        const rec = JSON.parse((await core.get(i)).toString('utf8'))
        if (rec && typeof rec.tableKey === 'string') latest.set(rec.tableKey, rec)
      } catch { /* skip corrupt index block */ }
    }
    const done = []
    this._rehydrating = true
    try {
      for (const rec of latest.values()) {
        if (this.pokerApp.getState(rec.tableKey)) continue // already live — skip
        try {
          await this.createPersistentTable(rec, { skipIndex: true })
          done.push(rec.tableKey)
        } catch (err) {
          this.emit('rehydrate-error', { tableKey: rec.tableKey, error: err && err.message })
          this._log('rehydrate-error', { tableKey: rec.tableKey, error: err && err.message })
        }
      }
    } finally {
      this._rehydrating = false
    }
    this.emit('rehydrated-all', { count: done.length })
    return { rehydrated: done.length, tableKeys: done }
  }

  /**
   * Stop mirroring for a single table. Does NOT close the core (it stays
   * available to the seeder for read), does NOT delete blocks, does NOT
   * close the PokerApp table (caller's responsibility).
   */
  detach (tableKey) {
    const key = String(tableKey).toLowerCase()
    const entry = this._mirrors.get(key)
    if (!entry) return false
    try { entry.unsub && entry.unsub() } catch {}
    this._mirrors.delete(key)
    return true
  }

  /**
   * Detach every table and mark the adapter stopped. Does NOT close the
   * underlying corestore (operator owns its lifecycle).
   */
  async stop () {
    this._stopped = true
    // Detach the create-hook so a stopped adapter never mirrors new tables.
    if (this.pokerApp && this.autoMirror && this.pokerApp._onTableCreated) {
      this.pokerApp._onTableCreated = null
    }
    for (const { unsub } of this._mirrors.values()) {
      try { unsub && unsub() } catch {}
    }
    this._mirrors.clear()
  }

  /**
   * Public list of currently-mirrored tables — useful for ops dashboards.
   */
  listMirrors () {
    const out = []
    for (const [tableKey, { core }] of this._mirrors) {
      out.push({
        tableKey,
        coreKey: core.key ? core.key.toString('hex') : null,
        length: core.length
      })
    }
    return out
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Append `entry` to the table's core. Wrapped in a timeout so a stalled
   * Hypercore doesn't pile up unbounded promises behind it.
   */
  async _mirror (tableKey, core, entry, index) {
    if (this._stopped) return
    // Index guard (idempotent + gap-safe): core blocks are 1:1 with log entries in
    // order, so only append when this entry sits exactly at the core's tail. An entry
    // already mirrored (index < core.length) is skipped — this is what makes the
    // subscribe-then-backfill race in attach() safe from double-writes.
    if (typeof index === 'number' && index < core.length) return
    const blob = Buffer.from(JSON.stringify(entry), 'utf8')
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('append-timeout')), APPEND_TIMEOUT_MS)
    })
    try {
      await Promise.race([core.append(blob), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Verify a parsed block looks like a SignedLog entry — enough that
 * `SignedLog._replay` won't crash on `entry.writer.toLowerCase()` or
 * `entry.seq` or `entry.ts`. We don't re-check the signature here (that
 * was checked at original ingest); we just ensure the fields exist with
 * the right primitive types.
 *
 * Returns null on OK, or a short reason string on failure.
 */
function _validateReplayEntryShape (e) {
  if (!e || typeof e !== 'object') return 'not-an-object'
  if (typeof e.writer !== 'string' || e.writer.length !== 64) return 'writer'
  if (typeof e.tableKey !== 'string' || e.tableKey.length !== 64) return 'tableKey'
  if (!Number.isInteger(e.seq) || e.seq < 0) return 'seq'
  if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) return 'ts'
  if (typeof e.signature !== 'string') return 'signature'
  return null
}

export { CORE_NAME_PREFIX, _validateReplayEntryShape as _validateReplayEntryShapeForTest }
