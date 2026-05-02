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
    // ReplicaSets observed across the network: appKey → { relayPubkey → meta }
    this._fleet = new Map()
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
      drives.push({
        appKey,
        replicas: live.replicas,
        regions: live.regions,
        operators: live.operators,
        meetsThreshold: this._meetsThreshold(live),
        haveLocally: this.node.appRegistry?.has?.(appKey) === true
      })
    }
    return {
      tickMs: this.tickMs,
      thresholds: this.thresholds,
      tracked: drives.length,
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

      // Recruit.
      try {
        await this.node.seedApp(appKey, {
          durability: ARCHIVE_TIER,
          revocable: false, // archive drives are non-revocable by definition
          source: 'auto-heal'
        })
        recruits++
        this.emit('recruited', {
          appKey,
          before: live,
          reason: live.regions.length < this.thresholds.minRegions ? 'region-gap' : 'replica-gap'
        })
      } catch (err) {
        this.emit('recruit-error', { appKey, error: err.message })
      }
    }
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
