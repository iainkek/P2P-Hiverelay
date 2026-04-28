/**
 * WebSocket live event feed for HiveWorm biomes
 *
 * Pushes signed entries to connected game clients as they're appended
 * to a biome's autobase log instead of requiring clients to poll
 * `GET /api/hiveworm/<biome>/log?from=N` every tick.
 *
 * Attaches to the existing HTTP server via the upgrade path
 * `/api/hiveworm/<biome-key>/events` where <biome-key> is the 64-char
 * hex biome identifier.
 *
 * Wire protocol (server -> client):
 *   { type: 'snapshot', state: <WorldState JSON> }   on connect
 *   { type: 'entry',    entry:  <signed entry>    }   per appended entry
 *   { type: 'error',    error:  <string>          }   before close
 *
 * Clients SHOULD NOT send anything on this socket. As a defence
 * against runaway clients we cap incoming traffic at 10 messages/sec
 * and 1KB per message, dropping the connection when either is breached.
 */

import { WebSocketServer } from 'ws'
import { isValidHexKey } from '../constants.js'

const EVENTS_PATH_PREFIX = '/api/hiveworm/'
const EVENTS_PATH_SUFFIX = '/events'
const MAX_MESSAGE_BYTES = 1024
const MAX_MESSAGES_PER_SEC = 10

export class HiveWormFeed {
  constructor (opts = {}) {
    this.server = opts.server
    this.node = opts.node
    this.corsOrigins = opts.corsOrigins || '*'
    this._apiKey = opts.apiKey || null
    this.wss = null
    this._upgradeHandler = null
    this._unsubscribers = new Map() // ws -> () => void
    this.clientCount = 0
  }

  start () {
    this.wss = new WebSocketServer({ noServer: true })

    this._upgradeHandler = (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost')
      const biomeKey = parseBiomeKey(url.pathname)
      if (biomeKey === null) return // not our path; let other listeners handle

      // Validate biome key shape
      if (!isValidHexKey(biomeKey, 64)) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }

      // Refuse if HiveWorm service hasn't been started on this relay
      if (!this.node || !this.node.hiveworm) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
        socket.destroy()
        return
      }

      // Origin check (mirrors DashboardFeed)
      if (this.corsOrigins !== '*') {
        const origin = req.headers.origin
        const allowed = Array.isArray(this.corsOrigins)
          ? this.corsOrigins
          : [this.corsOrigins]
        if (!origin || !allowed.includes(origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
      }

      // API key check via ?token=…
      if (this._apiKey) {
        const token = url.searchParams.get('token')
        if (token !== this._apiKey) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws._biomeKey = biomeKey
        this.wss.emit('connection', ws, req)
      })
    }
    this.server.on('upgrade', this._upgradeHandler)

    this.wss.on('connection', (ws) => {
      this.clientCount++
      this._wireConnection(ws).catch((err) => {
        try {
          ws.send(JSON.stringify({ type: 'error', error: err.message || 'init-failed' }))
        } catch {}
        try { ws.close() } catch {}
      })
    })
  }

  async _wireConnection (ws) {
    const biomeKey = ws._biomeKey
    const hiveworm = this.node && this.node.hiveworm
    if (!hiveworm) {
      try { ws.close() } catch {}
      return
    }

    // Per-connection rate-limit state for incoming messages
    const limiter = { windowStart: Date.now(), count: 0 }

    const cleanup = () => {
      const off = this._unsubscribers.get(ws)
      if (off) {
        try { off() } catch {}
        this._unsubscribers.delete(ws)
      }
    }

    ws.on('close', () => {
      this.clientCount--
      cleanup()
    })

    ws.on('error', () => {
      // Swallow — close handler will run cleanup
    })

    ws.on('message', (data) => {
      // Clients aren't supposed to send anything on this socket. Reject
      // oversize frames or anyone exceeding the per-second cap.
      const size = data && data.length ? data.length : 0
      if (size > MAX_MESSAGE_BYTES) {
        this._rejectClient(ws, 'message-too-large')
        return
      }
      const now = Date.now()
      if (now - limiter.windowStart >= 1000) {
        limiter.windowStart = now
        limiter.count = 0
      }
      limiter.count++
      if (limiter.count > MAX_MESSAGES_PER_SEC) {
        this._rejectClient(ws, 'rate-limit')
      }
    })

    // Pull current state so we can deliver a snapshot atomically with
    // subscribing — subscribe AFTER reading state to avoid losing the
    // first entry of the appended series.
    await hiveworm.ensureBiome(biomeKey)
    const state = await hiveworm.getState(biomeKey)
    if (ws.readyState !== 1 /* WebSocket.OPEN */) return

    try {
      ws.send(JSON.stringify({ type: 'snapshot', state }))
    } catch {
      try { ws.close() } catch {}
      return
    }

    const off = hiveworm.subscribe(biomeKey, (entry) => {
      if (ws.readyState !== 1) return
      try {
        ws.send(JSON.stringify({ type: 'entry', entry }))
      } catch {
        try { ws.close() } catch {}
      }
    })
    this._unsubscribers.set(ws, off)
  }

  _rejectClient (ws, reason) {
    try {
      ws.send(JSON.stringify({ type: 'error', error: reason }))
    } catch {}
    try { ws.close(1008, reason) } catch {}
  }

  stop () {
    // Detach upgrade handler
    if (this._upgradeHandler && this.server) {
      this.server.removeListener('upgrade', this._upgradeHandler)
      this._upgradeHandler = null
    }

    // Drop subscriptions for any still-connected clients
    for (const off of this._unsubscribers.values()) {
      try { off() } catch {}
    }
    this._unsubscribers.clear()

    // Close clients and the WS server
    if (this.wss) {
      for (const ws of this.wss.clients) {
        try { ws.close() } catch {}
      }
      this.wss.close()
      this.wss = null
    }

    this.clientCount = 0
  }
}

/**
 * Extract the biome key from `/api/hiveworm/<biome>/events`. Returns
 * the substring (which may or may not be a valid hex key) or `null` if
 * the path doesn't match this shape.
 */
function parseBiomeKey (pathname) {
  if (!pathname.startsWith(EVENTS_PATH_PREFIX)) return null
  if (!pathname.endsWith(EVENTS_PATH_SUFFIX)) return null
  const inner = pathname.slice(EVENTS_PATH_PREFIX.length, pathname.length - EVENTS_PATH_SUFFIX.length)
  // Must contain exactly the biome segment, no further slashes
  if (inner.length === 0 || inner.indexOf('/') !== -1) return null
  return inner
}
