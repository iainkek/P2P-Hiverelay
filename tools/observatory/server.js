// HiveRelay Observatory — Layer 1+2: log aggregator + topology poller.
//
// Polls each relay's HTTP endpoints every POLL_INTERVAL_MS, holds the latest
// snapshot in memory, exposes /api/state (current) + /api/history (last N
// polls) + a static dashboard at /. No DB; restart loses history but the
// next poll fills the current state in seconds.
//
// Single Node process, no deps beyond stdlib. Runs as systemd service on
// the observatory host (currently Bern). Designed to fit in <1 KB of RAM
// per relay across the snapshot history ring buffer.

import http from 'http'
import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.OBSERVATORY_PORT) || 9200
const POLL_INTERVAL_MS = Number(process.env.OBSERVATORY_POLL_MS) || 10_000
const HISTORY_LEN = Number(process.env.OBSERVATORY_HISTORY) || 360 // ~1 hour at 10s

// Fleet config. Per-relay API keys are intentionally NOT here — the
// observatory only hits public endpoints. If we later add authenticated
// pulls (/api/manage/*), we'll thread keys via env vars per relay.
const RELAYS = [
  { id: 'utah',        host: '144.172.101.215', region: 'NA', operator: 'hive-foundation-utah' },
  { id: 'utah-us',     host: '144.172.91.26',   region: 'NA', operator: 'hive-foundation-utah-us' },
  { id: 'singapore-1', host: '104.194.153.179', region: 'AS', operator: 'hive-foundation-singapore' },
  { id: 'singapore-2', host: '104.194.152.121', region: 'AS', operator: 'hive-foundation-singapore-2' },
  { id: 'bern',        host: '45.59.123.112',   region: 'EU', operator: 'hive-foundation-bern' }
]

// Current snapshot (overwritten every poll) + ring buffer of last N snapshots
// for trend lines. History is shallow on purpose: just the small derived
// metrics, not full peer lists, so the buffer doesn't grow unbounded.
let current = { updatedAt: null, relays: {} }
const history = []

async function fetchJson (url, timeoutMs = 5_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function pollRelay (relay) {
  const base = `http://${relay.host}:9100`
  const snap = {
    id: relay.id,
    host: relay.host,
    region: relay.region,
    operator: relay.operator,
    fetchedAt: Date.now(),
    up: false,
    errors: []
  }

  // Settle all five in parallel — slowest endpoint dictates wall time.
  // Using allSettled so one slow endpoint doesn't poison the snapshot.
  //
  // /catalog.json defaults to pageSize=50 with pagination; fetching with
  // pageSize=1000 grabs the whole catalog in one round-trip. Relays with
  // more than 1000 apps will need follow-the-pagination logic — fine for
  // now, the production fleet is well below that.
  const [health, peers, status, catalog, capability] = await Promise.allSettled([
    fetchJson(`${base}/health`),
    fetchJson(`${base}/peers`),
    fetchJson(`${base}/status`),
    fetchJson(`${base}/catalog.json?pageSize=1000`),
    fetchJson(`${base}/.well-known/hiverelay.json`)
  ])

  if (health.status === 'fulfilled') {
    snap.health = health.value
    snap.up = !!health.value.ok
    snap.running = !!health.value.running
    snap.uptimeMs = health.value.uptime?.ms ?? null
  } else {
    snap.errors.push({ endpoint: 'health', error: errorString(health.reason) })
  }

  if (peers.status === 'fulfilled') {
    snap.peerCount = peers.value.count ?? 0
    snap.peers = (peers.value.peers || []).map(p => ({
      pubkey: p.remotePublicKey ? p.remotePublicKey.slice(0, 12) : null
    }))
  } else {
    snap.errors.push({ endpoint: 'peers', error: errorString(peers.reason) })
  }

  if (status.status === 'fulfilled') {
    snap.status = status.value
  } else {
    snap.errors.push({ endpoint: 'status', error: errorString(status.reason) })
  }

  if (catalog.status === 'fulfilled') {
    const apps = catalog.value.apps || []
    snap.catalog = {
      relayKey: catalog.value.relayKey,
      total: catalog.value.count?.total ?? apps.length,
      anchored: apps.filter(a => a.anchored === true).length,
      apps: apps.slice(0, 50).map(a => ({
        key: a.appKey?.slice(0, 12),
        appId: a.appId || null,
        version: a.version || null,
        anchored: a.anchored === true,
        anchoredLength: a.anchoredLength || 0,
        type: a.type
      }))
    }
  } else {
    snap.errors.push({ endpoint: 'catalog', error: errorString(catalog.reason) })
  }

  if (capability.status === 'fulfilled') {
    snap.capability = {
      version: capability.value.version,
      schemaVersion: capability.value.schemaVersion,
      acceptMode: capability.value.acceptMode,
      transports: capability.value.transports,
      federation: capability.value.federation,
      identity: capability.value.identity?.publicKey?.slice(0, 12) || null
    }
  } else {
    snap.errors.push({ endpoint: 'capability', error: errorString(capability.reason) })
  }

  return snap
}

function errorString (err) {
  if (!err) return 'unknown'
  if (err.name === 'AbortError') return 'timeout'
  return err.message || String(err)
}

async function pollAll () {
  const results = await Promise.all(RELAYS.map(pollRelay))
  current = {
    updatedAt: Date.now(),
    relays: Object.fromEntries(results.map(s => [s.id, s]))
  }
  // Push compact derived metrics into the history ring.
  history.push({
    t: current.updatedAt,
    relays: Object.fromEntries(results.map(s => [s.id, {
      up: s.up,
      running: s.running,
      peers: s.peerCount,
      apps: s.catalog?.total ?? null,
      anchored: s.catalog?.anchored ?? null,
      version: s.capability?.version ?? null
    }]))
  })
  if (history.length > HISTORY_LEN) history.shift()
}

// First poll immediately, then on interval. Don't await the first one at
// boot — let the server come up so /api/state returns "still polling".
pollAll().catch(err => console.error('initial poll error:', err.message))
setInterval(() => {
  pollAll().catch(err => console.error('poll error:', err.message))
}, POLL_INTERVAL_MS)

// ── HTTP surface ─────────────────────────────────────────────────────────

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const route = url.pathname

    if (route === '/api/state') {
      return json(res, current)
    }
    if (route === '/api/history') {
      return json(res, { points: history.length, history })
    }
    if (route === '/api/config') {
      return json(res, { relays: RELAYS, pollIntervalMs: POLL_INTERVAL_MS })
    }
    if (route === '/healthz') {
      return json(res, { ok: true, pollAt: current.updatedAt })
    }

    // Static dashboard
    const file = route === '/' ? '/public/index.html' : route
    const safe = path.normalize(file).replace(/^(\.\.[\/])+/, '')
    const full = path.join(__dirname, safe)
    if (!full.startsWith(__dirname)) {
      res.writeHead(403); return res.end('forbidden')
    }
    const data = await readFile(full)
    const ct = STATIC_TYPES[path.extname(full)] || 'application/octet-stream'
    res.writeHead(200, { 'content-type': ct })
    return res.end(data)
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' })
    return res.end(err.code === 'ENOENT' ? 'not found' : 'error: ' + err.message)
  }
})

function json (res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

server.listen(PORT, () => {
  console.log(`HiveRelay Observatory v0.1 listening on http://0.0.0.0:${PORT}`)
  console.log(`Polling ${RELAYS.length} relays every ${POLL_INTERVAL_MS}ms`)
})
