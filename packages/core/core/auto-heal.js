/**
 * AutoHeal — diversity-enforced replica maintenance for archive-tier drives.
 *
 * Background scheduler that watches for archive-tier drives whose live
 * replica fleet has dropped below a diversity threshold and recruits this
 * relay as a fresh replica when doing so would meaningfully restore
 * diversity. Operates on cross-relay capability data already gathered by
 * the federation layer — it doesn't introduce new wire traffic; it just
 * computes a different decision over the existing data.
 *
 * Defaults target durable archival (≥7 replicas across ≥4 regions and ≥5
 * distinct operators). All thresholds are configurable via constructor
 * opts so operators can tune for their network density.
 *
 * State model:
 *
 *   For each archive drive seen via the cross-relay catalog:
 *     - Map<appKey, ReplicaSet>
 *     - ReplicaSet = { relayPubkey → { region, anchored, lastSeen } }
 *     - lastSeen pruned after `staleMs` (default 24h)
 *
 *   On each tick:
 *     1. Refresh ReplicaSets from the local app-registry catalog AND from
 *        peer-fetched catalogs cached on `node.federation`.
 *     2. For each archive drive: compute current (replicas, regions, operators).
 *     3. If below any threshold, decide whether THIS relay should recruit
 *        itself (would it improve diversity? do we have capacity? does
 *        accept-mode allow it?).
 *     4. If yes → call node.seedApp() with the same durability tier.
 *
 * What this is NOT:
 *   - Not a global coordinator. Every relay runs the same logic
 *     independently. Convergence comes from the diversity scoring: a relay
 *     in an over-represented region won't recruit itself, while one in an
 *     under-represented region will. Eventually the threshold is met.
 *   - Not a guarantee. Relies on at least one peer having the data
 *     reachable; can't rebuild a drive nobody has.
 *   - Not a replication protocol. Replication itself runs through the
 *     existing Hyperdrive + Hyperswarm path. AutoHeal just decides when to
 *     ask the local relay's seedApp() to start that replication.
 */

import EventEmitter from 'events'

// Default thresholds — tuned for an archival use case where availability
// matters more than over-replication. Operators can override via opts.
export const DEFAULT_THRESHOLDS = {
  minReplicas: 7,
  minRegions: 4,
  minOperators: 5
}

const DEFAULT_TICK_MS = 30 * 60 * 1000 // 30 min — slow loop; archival isn't latency-sensitive
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000 // 24h — peer info stale after this
const ARCHIVE_TIER = 1

export class AutoHeal extends EventEmitter {
  constructor (node, opts = {}) {
    super()
    this.node = node
    this.tickMs = opts.tickMs || DEFAULT_TICK_MS
    this.staleMs = opts.staleMs || DEFAULT_STALE_MS
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) }
    // Don't ever try to recruit ourselves into more than this many archive
    // drives in a single tick — back-pressure against a thundering herd
    // of new archive content all becoming our responsibility at once.
    this.maxRecruitsPerTick = opts.maxRecruitsPerTick || 3
    // Soft storage cap — refuse to recruit past this fraction of
    // maxStorageBytes. Default 90% leaves headroom for the seed-request
    // path + manifest growth between ticks.
    this.storageMargin = opts.storageMargin ?? 0.90
    // ReplicaSets observed across the network: appKey → { relayPubkey → meta }
    this._fleet = new Map()
    // Per-drive recruit-failure backoff. appKey → { failures, retryAt }.
    // Prevents tick-by-tick retry storms on permanently un-replicable drives.
    this._backoff = new Map()
    // Test seam — set to a deterministic [0,1) value to make jitter
    // decisions reproducible. In production it's Math.random.
    this._random = opts.random || (() => Math.random())
    this._timer = null
    this._running = false
  }

  start () {
    if (this._running) return
    this._running = true
    this._timer = setInterval(() => this._tick().catch((err) => {
      this.emit('tick-error', { error: err.message })
    }), this.tickMs)
    if (this._timer.unref) this._timer.unref()
    // Run once shortly after start so newly-booted relays don't have to
    // wait a full tick before discovering archive drives that need help.
    setTimeout(() => this._tick().catch(() => {}), 5000).unref?.()
    this.emit('started')
  }

  async stop () {
    if (!this._running) return
    this._running = false
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this.emit('stopped')
  }

  /**
   * Public snapshot for /api/health-detail and similar admin endpoints.
   * Returns the current view of archive-tier drives this relay is tracking
   * + whether each meets the diversity threshold.
   */
  snapshot () {
    const drives = []
    for (const [appKey, replicas] of this._fleet) {
      const live = this._liveReplicas(replicas)
      const back = this._backoff.get(appKey) || null
      drives.push({
        appKey,
        replicas: live.replicas,
        regions: live.regions,
        operators: live.operators,
        meetsThreshold: this._meetsThreshold(live),
        haveLocally: this.node.appRegistry?.has?.(appKey) === true,
        backoff: back
          ? { failures: back.failures, retryInMs: Math.max(0, back.retryAt - Date.now()) }
          : null
      })
    }
    return {
      enabled: true,
      running: this._running,
      tickMs: this.tickMs,
      thresholds: this.thresholds,
      maxRecruitsPerTick: this.maxRecruitsPerTick,
      storageMargin: this.storageMargin,
      tracked: drives.length,
      below: drives.filter(d => !d.meetsThreshold).length,
      backoffs: this._backoff.size,
      drives
    }
  }

  // ─── Internal: tick ────────────────────────────────────────────────

  async _tick () {
    if (!this._running) return
    if (!this.node.appRegistry) return

    // 1. Refresh from local catalog + peer catalogs.
    this._refreshFromLocal()
    this._refreshFromFederation()
    this._pruneStale()

    // 2. For each archive drive, decide whether to recruit.
    let recruits = 0
    for (const [appKey, replicas] of this._fleet) {
      if (recruits >= this.maxRecruitsPerTick) break

      const live = this._liveReplicas(replicas)
      if (this._meetsThreshold(live)) continue

      // Already seeding it locally? Nothing to do.
      if (this.node.appRegistry.has(appKey)) continue

      // Would adding US to this fleet meaningfully improve diversity?
      //
      // Two cases qualify:
      //   1. We bring a region the fleet doesn't already have. Highest-value
      //      recruitment — directly closes a regional gap.
      //   2. The fleet already meets the region threshold but is short on
      //      total replicas. Adding from a represented region still helps
      //      because more redundancy is a real win even if not new geo.
      //
      // Cases that DO NOT qualify:
      //   - Our region is over-represented AND replica count is already
      //     above the threshold — recruiting just inflates a popular region
      //     without closing any gap. Leave it for a relay that adds more.
      //   - Region threshold not yet met but our region wouldn't move us
      //     closer to it (we're already represented).
      const ourRegion = this._localRegion()
      const ourPubkey = this._localPubkey()
      const addsRegion = !live.regions.includes(ourRegion)
      const meetsRegionThreshold = live.regions.length >= this.thresholds.minRegions
      const belowReplicas = live.replicas < this.thresholds.minReplicas
      const wouldAddDiversity = (
        !replicas.has(ourPubkey) &&
        (addsRegion || (belowReplicas && meetsRegionThreshold))
      )
      if (!wouldAddDiversity) continue

      // Capacity / policy gates — same checks the seed-request handler
      // would apply. We refuse to recruit if we'd violate accept-mode
      // (operator may have explicitly closed the relay, set allowlist, etc.).
      if (!this._canAccept(appKey)) continue

      // Storage gate — refuse to recruit when we're already at the operator's
      // storage cap. seedApp() would error or evict; better to decline up
      // front and let a relay with capacity take it. We use a soft margin
      // (default 90%) so we don't keep recruiting until literally full.
      if (!this._hasStorageCapacity()) {
        this.emit('recruit-skipped', { appKey, reason: 'storage-full' })
        continue
      }

      // Backoff gate — if recruiting this drive failed recently, wait before
      // retrying. Prevents tick-by-tick retry storms when a drive is
      // permanently un-replicable (e.g., publisher gone, we can't connect
      // to any peer that has it).
      if (this._isInBackoff(appKey)) continue

      // Convergence jitter — at scale, many archive-aware relays will see
      // the same shortfall in the same tick and all decide to recruit. The
      // result is that a drive needing 1 new replica gets 50, blowing
      // through the diversity target. Mitigation: each relay independently
      // recruits with probability proportional to "how much help is needed
      // vs. how many relays could help." Roughly: with N relays observing
      // the same gap and a gap of K replicas, each relay recruits with
      // probability ≈ K/N.
      //
      // We don't know N (the network's total auto-heal-enabled fleet), so
      // we approximate from the visible fleet size. This isn't perfectly
      // tight but converges fast: relays that lose the dice roll see the
      // recruitment in the next tick's catalog and stand down.
      if (!this._jitterAccept(live)) {
        this.emit('recruit-skipped', { appKey, reason: 'jitter-defer' })
        continue
      }

      // Recruit.
      try {
        await this.node.seedApp(appKey, {
          durability: ARCHIVE_TIER,
          revocable: false, // archive drives are non-revocable by definition
          source: 'auto-heal'
        })
        recruits++
        this._clearBackoff(appKey) // success — clear any prior backoff
        this.emit('recruited', {
          appKey,
          before: live,
          reason: live.regions.length < this.thresholds.minRegions ? 'region-gap' : 'replica-gap'
        })
      } catch (err) {
        this._recordFailure(appKey)
        this.emit('recruit-error', { appKey, error: err.message })
      }
    }
  }

  // ─── Internal: capacity, backoff, jitter ───────────────────────────

  _hasStorageCapacity () {
    const seeder = this.node.seeder
    const cap = this.node.config?.maxStorageBytes
    if (!seeder || !cap) return true // unbounded — let it through
    const used = seeder.totalBytesStored || 0
    const margin = this.storageMargin || 0.90
    return used < (cap * margin)
  }

  _isInBackoff (appKey) {
    const entry = this._backoff.get(appKey)
    if (!entry) return false
    if (Date.now() >= entry.retryAt) {
      this._backoff.delete(appKey)
      return false
    }
    return true
  }

  _recordFailure (appKey) {
    const prior = this._backoff.get(appKey)
    const failures = (prior?.failures || 0) + 1
    // Exponential backoff with cap: 5min, 15min, 1h, 4h, 24h, 24h (max).
    const delays = [5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000]
    const delay = delays[Math.min(failures - 1, delays.length - 1)]
    this._backoff.set(appKey, {
      failures,
      retryAt: Date.now() + delay
    })
  }

  _clearBackoff (appKey) {
    this._backoff.delete(appKey)
  }

  _jitterAccept (live) {
    // Estimate how many relays could fix this gap and how big the gap is.
    // visiblePeers ≈ relays we know about that aren't already replicas.
    // We need (replicas + regions + operators) all to hit threshold; use the
    // worst single-dimension shortfall as gap.
    const replicaGap = Math.max(0, this.thresholds.minReplicas - live.replicas)
    const regionGap = Math.max(0, this.thresholds.minRegions - live.regions.length)
    const operatorGap = Math.max(0, this.thresholds.minOperators - live.operators.length)
    const gap = Math.max(replicaGap, regionGap, operatorGap)
    if (gap <= 0) return true // shouldn't happen; meetsThreshold gates above

    // Estimate fleet of helpers from federation snapshot. Default to a
    // conservative N=20 if we have less data than that.
    const peerCount = this._fleetSize() || 20
    const helpers = Math.max(peerCount, 3)
    const probability = Math.min(1, (gap * 2) / helpers) // 2× for safety margin
    return this._random() < probability
  }

  _fleetSize () {
    if (!this.node.federation || typeof this.node.federation.snapshot !== 'function') return 0
    const snap = this.node.federation.snapshot()
    return Array.isArray(snap?.peerCatalogs) ? snap.peerCatalogs.length : 0
  }

  // ─── Internal: data refresh ────────────────────────────────────────

  _refreshFromLocal () {
    const now = Date.now()
    const ourPubkey = this._localPubkey()
    const ourRegion = this._localRegion()
    if (!this.node.appRegistry.catalog) return

    for (const entry of this.node.appRegistry.catalog()) {
      if ((entry.durability || 0) !== ARCHIVE_TIER) continue
      const set = this._setFor(entry.appKey)
      set.set(ourPubkey, {
        region: ourRegion,
        anchored: entry.anchored === true,
        lastSeen: now
      })
    }
  }

  _refreshFromFederation () {
    if (!this.node.federation || typeof this.node.federation.snapshot !== 'function') return
    const now = Date.now()
    const snap = this.node.federation.snapshot()
    if (!Array.isArray(snap?.peerCatalogs)) return

    for (const peer of snap.peerCatalogs) {
      const peerPubkey = peer.pubkey
      const peerRegion = peer.region || 'unknown'
      if (!peerPubkey || !Array.isArray(peer.apps)) continue

      for (const app of peer.apps) {
        if ((app.durability || 0) !== ARCHIVE_TIER) continue
        const appKey = app.appKey || app.driveKey || app.key
        if (!appKey) continue

        const set = this._setFor(appKey)
        set.set(peerPubkey, {
          region: peerRegion,
          anchored: app.anchored === true,
          lastSeen: now
        })
      }
    }
  }

  _pruneStale () {
    const cutoff = Date.now() - this.staleMs
    for (const [appKey, replicas] of this._fleet) {
      for (const [pubkey, meta] of replicas) {
        if (meta.lastSeen < cutoff) replicas.delete(pubkey)
      }
      if (replicas.size === 0) this._fleet.delete(appKey)
    }
  }

  _setFor (appKey) {
    let s = this._fleet.get(appKey)
    if (!s) {
      s = new Map()
      this._fleet.set(appKey, s)
    }
    return s
  }

  // ─── Internal: scoring / policy ────────────────────────────────────

  _liveReplicas (replicas) {
    // Count only ANCHORED replicas — a relay that accepted the seed but
    // hasn't actually replicated bytes is not a real availability vote.
    const anchored = []
    for (const [pubkey, meta] of replicas) {
      if (meta.anchored) anchored.push({ pubkey, region: meta.region })
    }
    const regions = [...new Set(anchored.map(r => r.region).filter(Boolean))]
    const operators = [...new Set(anchored.map(r => r.pubkey))]
    return {
      replicas: anchored.length,
      regions,
      operators,
      raw: anchored
    }
  }

  _meetsThreshold (live) {
    return (
      live.replicas >= this.thresholds.minReplicas &&
      live.regions.length >= this.thresholds.minRegions &&
      live.operators.length >= this.thresholds.minOperators
    )
  }

  _localPubkey () {
    if (this.node.swarm?.keyPair?.publicKey) {
      const pk = this.node.swarm.keyPair.publicKey
      return typeof pk === 'string' ? pk : pk.toString('hex')
    }
    return 'self'
  }

  _localRegion () {
    return (this.node.config?.regions?.[0]) || 'unknown'
  }

  _canAccept (appKey) {
    if (typeof this.node._resolveAcceptMode !== 'function') return true
    if (typeof this.node._decideAcceptance !== 'function') return true
    const mode = this.node._resolveAcceptMode()
    const decision = this.node._decideAcceptance({
      appKey,
      source: 'auto-heal',
      durability: ARCHIVE_TIER
    }, mode)
    return decision === 'accept'
  }
}
