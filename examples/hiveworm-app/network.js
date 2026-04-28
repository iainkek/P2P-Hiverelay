// HiveWorm — relay HTTP/WS client
//
// Wraps the four endpoints documented in packages/core/core/relay-node/api.js:
//   GET  /api/hiveworm/biomes
//   GET  /api/hiveworm/<biome>/state
//   GET  /api/hiveworm/<biome>/log?from=<idx>
//   POST /api/hiveworm/<biome>/move
//   WS   /api/hiveworm/<biome>/events    (designed for; falls back to polling)
//
// The WS endpoint is being built by another agent — this client tries it
// first and gracefully degrades to polling /state every config.pollFallbackMs
// if WS isn't available or fails.

import { config } from './config.js'

export class Network {
  constructor ({ relayBase, biome, onEntry, onState, onError } = {}) {
    this.relayBase = (relayBase || config.relayBase).replace(/\/+$/, '')
    this.biome = biome || config.defaultBiome
    this.onEntry = onEntry || (() => {})
    this.onState = onState || (() => {})
    this.onError = onError || (() => {})

    this._ws = null
    this._wsState = 'idle' // 'idle' | 'connecting' | 'open' | 'closed'
    this._pollTimer = null
    this._lastLogIndex = 0
    this._stopped = false
  }

  // ─── HTTP ─────────────────────────────────────────────────

  async listBiomes () {
    const r = await fetch(this.relayBase + '/api/hiveworm/biomes')
    if (!r.ok) throw new Error('listBiomes: ' + r.status)
    return r.json()
  }

  async getState () {
    const r = await fetch(this.relayBase + '/api/hiveworm/' + this.biome + '/state')
    if (!r.ok) throw new Error('getState: HTTP ' + r.status)
    return r.json()
  }

  async getLog (fromIdx = 0) {
    const r = await fetch(this.relayBase + '/api/hiveworm/' + this.biome + '/log?from=' + fromIdx)
    if (!r.ok) throw new Error('getLog: HTTP ' + r.status)
    return r.json()
  }

  /**
   * POST a signed entry to /move. Returns:
   *   { ok: true, index, tick }
   *   { ok: false, reason, layer }   on 422
   * Throws on transport / 500-class errors.
   */
  async submitMove (signedEntry) {
    const url = this.relayBase + '/api/hiveworm/' + this.biome + '/move'
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signedEntry)
    })
    let body
    try { body = await r.json() } catch (_) { body = null }
    if (r.status === 422) {
      return { ok: false, reason: body?.error || 'rejected', layer: body?.layer || 'unknown' }
    }
    if (!r.ok) {
      throw new Error('submitMove: HTTP ' + r.status + ' ' + (body?.error || ''))
    }
    return { ok: true, index: body.index, tick: body.tick }
  }

  // ─── Live updates: WS first, polling fallback ────────────

  start () {
    this._stopped = false
    this._connectWs()
  }

  stop () {
    this._stopped = true
    if (this._ws) {
      try { this._ws.close() } catch (_) {}
      this._ws = null
    }
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  }

  _connectWs () {
    if (this._stopped) return
    const wsUrl = this.relayBase.replace(/^http/, 'ws') +
      '/api/hiveworm/' + this.biome + '/events'
    this._wsState = 'connecting'
    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      this._fallbackToPolling('ws-construct-failed: ' + err.message)
      return
    }
    this._ws = ws

    let opened = false
    ws.addEventListener('open', () => {
      opened = true
      this._wsState = 'open'
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch (_) { return }
      // Expected envelopes (designed for the other agent's WS):
      //   { type: 'entry', entry: {...} }
      //   { type: 'state', state: {...} }
      // Be generous: accept bare entries / states too.
      if (msg && msg.type === 'entry' && msg.entry) {
        this.onEntry(msg.entry)
      } else if (msg && msg.type === 'state' && msg.state) {
        this.onState(msg.state)
      } else if (msg && msg.schema && typeof msg.schema === 'string') {
        this.onEntry(msg)
      } else if (msg && msg.worms && msg.food) {
        this.onState(msg)
      }
    })
    ws.addEventListener('close', () => {
      this._wsState = 'closed'
      if (this._stopped) return
      if (!opened) {
        // Never connected — fall back to polling
        this._fallbackToPolling('ws-never-opened')
      } else {
        // Was connected; try to reconnect after a short delay
        setTimeout(() => this._connectWs(), config.reconnectDelayMs)
      }
    })
    ws.addEventListener('error', () => {
      // 'error' fires before 'close' — let 'close' handle reconnection.
    })
  }

  _fallbackToPolling (why) {
    if (this._stopped) return
    if (this._pollTimer) return
    // We don't surface this loudly — UI will pick up state via onState.
    console.info('[hiveworm] WS unavailable (' + why + '); polling /state every ' + config.pollFallbackMs + 'ms')
    this._poll()
  }

  async _poll () {
    if (this._stopped) return
    try {
      const log = await this.getLog(this._lastLogIndex)
      if (Array.isArray(log.entries) && log.entries.length > 0) {
        for (const e of log.entries) this.onEntry(e)
        this._lastLogIndex = log.from + log.entries.length
      } else if (this._lastLogIndex === 0) {
        // First poll — no entries yet; pull state instead
        const st = await this.getState()
        this.onState(st)
        // The state alone tells us where we are; tick != log index, but
        // the log getLog will resync naturally next tick.
      }
    } catch (err) {
      this.onError(err)
    } finally {
      if (this._stopped) return
      this._pollTimer = setTimeout(() => this._poll(), config.pollFallbackMs)
    }
  }
}
