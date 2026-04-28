/**
 * HiveWorm — WorldState class.
 *
 * Pure data + helpers. The deriver constructs a WorldState by replaying
 * autobase entries; the validator checks proposed entries against a
 * WorldState; the API serializes WorldState for the /state endpoint.
 *
 * Worms are stored as { pubkey, segments: [[x, y], ...], length, alive,
 * lastMoveTs }. Food is { x, y, value }.
 *
 * Directions are unit vectors: N=(0,-1) S=(0,1) E=(1,0) W=(-1,0).
 */

const DIR_VEC = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0]
}

export class WorldState {
  constructor (config = {}) {
    this.config = {
      width: 200,
      height: 200,
      moveCooldownMs: 5000,
      spawnLength: 3,
      targetFoodCount: 50,
      foodSeed: '0000000000000000000000000000000000000000000000000000000000000000',
      ...config
    }
    this.tick = 0
    this.worms = new Map() // pubkey -> { pubkey, segments, length, alive, lastMoveTs, bornAt }
    this.food = new Map() // "x,y" -> { x, y, value }
    this.deaths = [] // { pubkey, atPos, byPubkey, atTick }
    this.memorials = [] // { pubkey, atPos, epitaph, atTick }
    this.processedNonces = new Set() // dedup
    this._spawnFood()
  }

  // ─── Cell helpers ──────────────────────────────────────────

  inBounds (x, y) {
    return x >= 0 && y >= 0 && x < this.config.width && y < this.config.height
  }

  cellKey (x, y) { return x + ',' + y }

  /**
   * Returns the worm pubkey occupying (x, y), or null. Iterates worms
   * (small N for v1; later: maintain reverse-index).
   */
  occupant (x, y) {
    for (const w of this.worms.values()) {
      if (!w.alive) continue
      for (const [sx, sy] of w.segments) {
        if (sx === x && sy === y) return w.pubkey
      }
    }
    return null
  }

  // ─── Food management (deterministic) ─────────────────────

  _spawnFood () {
    // Deterministic food distribution based on foodSeed + grid hash.
    // Replay-safe: same biome → same food layout.
    let n = 0
    let i = 0
    const seed = this.config.foodSeed
    while (n < this.config.targetFoodCount && i < this.config.targetFoodCount * 4) {
      // Cheap deterministic PRNG: xorshift on seed bytes + counter
      const x = this._prng(seed, 'fx', i) % this.config.width
      const y = this._prng(seed, 'fy', i) % this.config.height
      const k = this.cellKey(x, y)
      if (!this.food.has(k)) {
        this.food.set(k, { x, y, value: 1 })
        n++
      }
      i++
    }
  }

  _replenishFood (consumedAtTick) {
    if (this.food.size >= this.config.targetFoodCount) return
    let attempts = 0
    while (this.food.size < this.config.targetFoodCount && attempts < 16) {
      const x = this._prng(this.config.foodSeed, 'replenish-x', this.tick + attempts) % this.config.width
      const y = this._prng(this.config.foodSeed, 'replenish-y', this.tick + attempts) % this.config.height
      const k = this.cellKey(x, y)
      if (!this.food.has(k) && !this.occupant(x, y)) {
        this.food.set(k, { x, y, value: 1 })
      }
      attempts++
    }
  }

  _prng (seedHex, label, n) {
    // Simple FNV-1a hash for determinism (no crypto needed; low-stakes)
    let h = 0x811c9dc5
    const data = seedHex + ':' + label + ':' + n
    for (let i = 0; i < data.length; i++) {
      h ^= data.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h
  }

  // ─── Direction → coords ──────────────────────────────────

  static dirVec (d) { return DIR_VEC[d] || null }

  // ─── Serialization ───────────────────────────────────────

  toJSON () {
    return {
      tick: this.tick,
      config: this.config,
      worms: [...this.worms.values()].map(w => ({
        pubkey: w.pubkey,
        segments: w.segments,
        length: w.length,
        alive: w.alive,
        lastMoveTs: w.lastMoveTs,
        bornAt: w.bornAt
      })),
      food: [...this.food.values()],
      deaths: this.deaths.slice(-100), // recent only
      memorials: this.memorials.slice(-100)
    }
  }
}
