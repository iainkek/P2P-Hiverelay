/**
 * Hyperswarm firewall callback for blind relays.
 *
 * Hyperswarm calls this BEFORE the Noise handshake completes. Returning
 * `true` rejects the connection at the network layer — no Protomux
 * channels allocated, no rate-limiter touched, no event-loop ticks burned
 * on spam. This is the cheapest possible DoS defense.
 *
 * The firewall composes three signals:
 *
 *   1. Explicit allow / block lists (operator-controlled, persistent)
 *   2. Per-IP connection-rate limit (transient memory)
 *   3. Reputation-based threshold (optional — only active if a reputation
 *      system is wired in via `getReputationScore`)
 *
 * Order of evaluation (first match wins):
 *
 *   Allowlist → ACCEPT
 *   Blocklist → REJECT
 *   IP rate-limit exceeded → REJECT
 *   Reputation below threshold → REJECT
 *   Otherwise → ACCEPT
 *
 * Default config errs on the side of "let it through" — operators tighten
 * via the management TUI / wizard.
 */

import b4a from 'b4a'

const DEFAULT_IP_WINDOW_MS = 60_000
const DEFAULT_IP_MAX_CONNECTS = 100
const DEFAULT_MIN_REPUTATION = -1000 // disabled by default; -1000 ≈ "must be very actively bad"
const CLEANUP_INTERVAL_MS = 5 * 60_000

export class SwarmFirewall {
  /**
   * @param {object} opts
   * @param {Set<string>|Array<string>} [opts.allowlist] - hex pubkeys always accepted
   * @param {Set<string>|Array<string>} [opts.blocklist] - hex pubkeys always rejected
   * @param {number} [opts.ipWindowMs=60000]
   * @param {number} [opts.ipMaxConnects=100]
   * @param {number} [opts.minReputation=-1000] - reject pubkeys with reputation strictly below this
   * @param {function} [opts.getReputationScore] - (pubkeyHex) => number | null
   * @param {function} [opts.onReject] - ({ reason, pubkey, ip }) => void
   * @param {function} [opts.now] - injectable clock for tests
   */
  constructor (opts = {}) {
    this.allowlist = new Set(opts.allowlist || [])
    this.blocklist = new Set(opts.blocklist || [])
    this.ipWindowMs = opts.ipWindowMs ?? DEFAULT_IP_WINDOW_MS
    this.ipMaxConnects = opts.ipMaxConnects ?? DEFAULT_IP_MAX_CONNECTS
    this.minReputation = opts.minReputation ?? DEFAULT_MIN_REPUTATION
    this.getReputationScore = typeof opts.getReputationScore === 'function'
      ? opts.getReputationScore
      : null
    this.onReject = typeof opts.onReject === 'function' ? opts.onReject : null
    this._now = opts.now || (() => Date.now())

    this._ipBuckets = new Map() // ip -> [timestamps]
    this._stats = { accepted: 0, rejected: 0, byReason: {} }

    this._cleanup = setInterval(() => this._evictStaleIPs(), CLEANUP_INTERVAL_MS)
    if (this._cleanup.unref) this._cleanup.unref()
  }

  /**
   * The Hyperswarm-shaped callback. Returns `true` to REJECT.
   *
   *   new Hyperswarm({ firewall: fw.check.bind(fw) })
   *
   * @param {Buffer} remotePubKey 32-byte Noise pubkey of the connecting peer
   * @param {object} [payload] additional handshake payload (unused today)
   * @returns {boolean} true → reject, false → accept
   */
  check (remotePubKey, payload) {
    const pubkeyHex = remotePubKey ? b4a.toString(remotePubKey, 'hex') : null
    const ip = (payload && payload.remoteAddress) || null

    // 1. Allowlist short-circuit
    if (pubkeyHex && this.allowlist.has(pubkeyHex)) {
      this._record('accept', null)
      return false
    }

    // 2. Blocklist
    if (pubkeyHex && this.blocklist.has(pubkeyHex)) {
      this._record('reject', 'blocklist', { pubkey: pubkeyHex, ip })
      return true
    }

    // 3. IP rate limit
    if (ip && this._ipExceeded(ip)) {
      this._record('reject', 'ip-rate-limit', { pubkey: pubkeyHex, ip })
      return true
    }

    // 4. Reputation threshold
    if (this.getReputationScore && pubkeyHex) {
      const score = this.getReputationScore(pubkeyHex)
      if (typeof score === 'number' && score < this.minReputation) {
        this._record('reject', 'low-reputation', { pubkey: pubkeyHex, ip, score })
        return true
      }
    }

    this._record('accept', null)
    return false
  }

  // ─── Operator-mutable controls ──────────────────────────────────

  allow (pubkeyHex) {
    if (!pubkeyHex) return
    this.allowlist.add(pubkeyHex)
    this.blocklist.delete(pubkeyHex) // mutual exclusion
  }

  unallow (pubkeyHex) {
    this.allowlist.delete(pubkeyHex)
  }

  block (pubkeyHex) {
    if (!pubkeyHex) return
    this.blocklist.add(pubkeyHex)
    this.allowlist.delete(pubkeyHex)
  }

  unblock (pubkeyHex) {
    this.blocklist.delete(pubkeyHex)
  }

  isAllowed (pubkeyHex) {
    return this.allowlist.has(pubkeyHex)
  }

  isBlocked (pubkeyHex) {
    return this.blocklist.has(pubkeyHex)
  }

  stats () {
    return {
      accepted: this._stats.accepted,
      rejected: this._stats.rejected,
      byReason: { ...this._stats.byReason },
      allowlist: this.allowlist.size,
      blocklist: this.blocklist.size,
      ipBuckets: this._ipBuckets.size
    }
  }

  destroy () {
    if (this._cleanup) {
      clearInterval(this._cleanup)
      this._cleanup = null
    }
    this._ipBuckets.clear()
  }

  // ─── Internal ──────────────────────────────────────────────────

  _ipExceeded (ip) {
    const now = this._now()
    const cutoff = now - this.ipWindowMs
    let bucket = this._ipBuckets.get(ip)
    if (!bucket) {
      bucket = []
      this._ipBuckets.set(ip, bucket)
    }
    // Drop expired entries
    while (bucket.length && bucket[0] < cutoff) bucket.shift()
    if (bucket.length >= this.ipMaxConnects) return true
    bucket.push(now)
    return false
  }

  _evictStaleIPs () {
    const cutoff = this._now() - this.ipWindowMs
    for (const [ip, bucket] of this._ipBuckets) {
      while (bucket.length && bucket[0] < cutoff) bucket.shift()
      if (bucket.length === 0) this._ipBuckets.delete(ip)
    }
  }

  _record (kind, reason, details) {
    if (kind === 'accept') {
      this._stats.accepted++
    } else {
      this._stats.rejected++
      if (reason) {
        this._stats.byReason[reason] = (this._stats.byReason[reason] || 0) + 1
      }
      if (this.onReject) {
        try { this.onReject({ reason, ...details }) } catch (_) { /* swallow */ }
      }
    }
  }
}
