// HiveWorm — peer-to-peer network layer
//
// HiveWorm is a standalone app: there is no game-server. Players exchange
// signed entries directly via Hyperswarm, and each client maintains its own
// view of the world by replaying entries.
//
// Three runtime modes, picked at start():
//
//   1. PearBrowser desktop v0.3+ (window.pear.swarm.v1)
//      → join a drive-derived topic (Tier A, no consent prompt)
//      → broadcast moves to peers, receive theirs
//
//   2. Any other browser
//      → single-player local mode. The world is generated deterministically
//        from the biome key; you can play but no one else sees you.
//
// The interface (start, stop, submitMove, callbacks) is the same in both
// modes so game.js doesn't care which one is running.
//
// Wire format on the swarm:
//   { kind: 'entry',     entry: <signed entry> }   announce a single move
//   { kind: 'snapshot',  state: <world JSON>   }   share full state w/ a peer
//   { kind: 'sync-req'                          }   ask for a snapshot
//
// Snapshot/sync-req exist so a late-joiner doesn't see an empty meadow when
// other players are already running around.

import { config } from './config.js'

const SUBTOPIC_PREFIX = 'hiveworm/biome/'
const PROTOCOL_NAME = 'hiveworm'
const PROTOCOL_VERSION = 1

export class Network {
  constructor ({ biome, onEntry, onState, onError, onPeerCount } = {}) {
    this.biome = biome || config.defaultBiome
    this.onEntry = onEntry || (() => {})
    this.onState = onState || (() => {})
    this.onError = onError || (() => {})
    this.onPeerCount = onPeerCount || (() => {})

    this.mode = 'unknown' // 'pearbrowser' | 'local'
    this.channel = null
    this._stopped = false

    // Track recent broadcasts so we don't echo our own messages back to
    // ourselves if a peer rebroadcasts us
    this._sentNonces = new Set()
    this._sentNonceQueue = []
    this._maxRememberedNonces = 1024
  }

  // ─── Lifecycle ────────────────────────────────────────────

  async start () {
    if (this._stopped) return
    if (typeof window !== 'undefined' && window.pear?.swarm?.v1) {
      try {
        await this._startSwarm()
        return
      } catch (err) {
        console.warn('[hiveworm] swarm.v1 join failed; dropping to local mode', err)
        this.onError(err)
      }
    }
    this._startLocal()
  }

  stop () {
    this._stopped = true
    if (this.channel) {
      try { this.channel.destroy() } catch (_) {}
      this.channel = null
    }
  }

  // ─── PearBrowser swarm.v1 mode ────────────────────────────

  async _startSwarm () {
    const subtopic = SUBTOPIC_PREFIX + this.biome.slice(0, 32)
    this.channel = await window.pear.swarm.v1.join(null, {
      subtopic,
      protocol: PROTOCOL_NAME,
      version: PROTOCOL_VERSION,
      appName: 'HiveWorm'
    })
    this.mode = 'pearbrowser'

    this.channel.on('peer', (peer) => {
      this._reportPeerCount()
      // Ask a freshly-discovered peer for a snapshot so we don't see an
      // empty meadow if others are already playing.
      this._sendTo(peer, { kind: 'sync-req' })
    })

    this.channel.on('peer-leave', () => this._reportPeerCount())

    this.channel.on('message', (peer, data) => {
      let msg
      try { msg = JSON.parse(new TextDecoder().decode(data)) } catch (_) { return }
      if (!msg || typeof msg.kind !== 'string') return

      if (msg.kind === 'entry' && msg.entry && typeof msg.entry.schema === 'string') {
        if (msg.entry.nonce && this._sentNonces.has(msg.entry.nonce)) return // ours
        this.onEntry(msg.entry)
      } else if (msg.kind === 'snapshot' && msg.state) {
        this.onState(msg.state)
      } else if (msg.kind === 'sync-req') {
        // Caller will plug in a snapshot provider via setSnapshotProvider();
        // until they do, ignore the request.
        if (this._snapshotProvider) {
          const state = this._snapshotProvider()
          if (state) this._sendTo(peer, { kind: 'snapshot', state })
        }
      }
    })

    this.channel.on('error', (err) => this.onError(err))
    this.channel.on('closed', () => { this.channel = null })

    // Bootstrap world locally from biome key — peers will overlay their
    // own state via subsequent snapshot/entry messages.
    this._emitBootstrapState()
  }

  // ─── Single-player local mode ─────────────────────────────

  _startLocal () {
    this.mode = 'local'
    this._emitBootstrapState()
  }

  // ─── Submit / broadcast ───────────────────────────────────

  /**
   * Apply a signed entry to the world (handled by caller via onEntry) and
   * broadcast it to all peers.
   *
   * Returns { ok: true, local: true } — the relay-server's reject reasons
   * (race-lost, biome-mismatch, etc.) don't apply in pure-P2P; validation
   * is the caller's job before submit.
   */
  async submitMove (signedEntry) {
    if (this._stopped) return { ok: false, reason: 'stopped' }
    if (signedEntry?.nonce) this._rememberNonce(signedEntry.nonce)
    this._broadcast({ kind: 'entry', entry: signedEntry })
    // Caller still applies via onEntry — pure-P2P trust model.
    this.onEntry(signedEntry)
    return { ok: true, local: true }
  }

  /**
   * Caller (game.js) plugs in a function that returns the current
   * WorldState JSON. We invoke it when a peer asks for a snapshot.
   */
  setSnapshotProvider (fn) {
    this._snapshotProvider = fn
  }

  // ─── Helpers ──────────────────────────────────────────────

  _emitBootstrapState () {
    // Empty world, deterministic config. world.seedFood(biome) draws the
    // food deterministically so all peers agree on the layout.
    this.onState({
      tick: 0,
      worms: [],
      food: [], // intentionally empty — caller calls world.seedFood
      deaths: [],
      memorials: [],
      config: {
        width: config.worldWidth,
        height: config.worldHeight,
        moveCooldownMs: config.moveCooldownMs,
        spawnLength: 3,
        targetFoodCount: 50
      },
      _bootstrap: true
    })
  }

  _broadcast (msg) {
    if (!this.channel || !this.channel.peers) return
    const buf = new TextEncoder().encode(JSON.stringify(msg))
    for (const peer of this.channel.peers) {
      try { peer.send(buf) } catch (_) {}
    }
  }

  _sendTo (peer, msg) {
    try {
      const buf = new TextEncoder().encode(JSON.stringify(msg))
      peer.send(buf)
    } catch (_) {}
  }

  _reportPeerCount () {
    const n = this.channel?.peers?.length || 0
    this.onPeerCount(n)
  }

  _rememberNonce (nonce) {
    if (this._sentNonces.has(nonce)) return
    this._sentNonces.add(nonce)
    this._sentNonceQueue.push(nonce)
    if (this._sentNonceQueue.length > this._maxRememberedNonces) {
      const evicted = this._sentNonceQueue.shift()
      this._sentNonces.delete(evicted)
    }
  }

  // ─── Compatibility shims for callers that expected the relay API ──

  // The old code calls network.getState() at startup. In pure-P2P there is
  // no /state endpoint — return the bootstrap snapshot synchronously.
  async getState () {
    return {
      tick: 0,
      worms: [],
      food: [],
      deaths: [],
      memorials: [],
      config: {
        width: config.worldWidth,
        height: config.worldHeight,
        moveCooldownMs: config.moveCooldownMs,
        spawnLength: 3,
        targetFoodCount: 50
      }
    }
  }
}
