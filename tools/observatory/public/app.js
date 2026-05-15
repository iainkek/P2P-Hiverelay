// Dashboard client — polls /api/state every 5s, renders relay cards.
// No framework, no build step. ~150 lines, fits in one screen.

const REFRESH_MS = 5_000

// Map of known relay pubkeys → friendly names so the peer list reads as
// "(Utah-US)" instead of "37cf4bfbdf33". Populated from /api/config on boot.
const KNOWN = new Map()
let SELF_KEY = null

async function bootConfig () {
  try {
    const res = await fetch('/api/config')
    const cfg = await res.json()
    document.getElementById('poll-interval').textContent = (cfg.pollIntervalMs / 1000) + 's'
  } catch (err) {
    /* non-fatal */
  }
}

async function refresh () {
  try {
    const res = await fetch('/api/state')
    const state = await res.json()
    rebuildKnownMap(state)
    render(state)
  } catch (err) {
    document.getElementById('updated').textContent = 'Error: ' + err.message
  }
}

function rebuildKnownMap (state) {
  KNOWN.clear()
  for (const [id, snap] of Object.entries(state.relays || {})) {
    const k = snap.capability?.identity || snap.catalog?.relayKey?.slice(0, 12)
    if (k) KNOWN.set(k, id)
  }
}

function render (state) {
  if (!state.updatedAt) {
    document.getElementById('updated').textContent = 'Polling…'
    return
  }
  const age = Math.round((Date.now() - state.updatedAt) / 1000)
  document.getElementById('updated').textContent =
    `Last updated: ${new Date(state.updatedAt).toLocaleTimeString()} (${age}s ago)`

  const grid = document.getElementById('grid')
  grid.innerHTML = ''

  for (const [id, snap] of Object.entries(state.relays || {})) {
    grid.appendChild(renderRelay(id, snap))
  }
}

function renderRelay (id, snap) {
  const div = document.createElement('div')
  div.className = 'relay' + (snap.up ? '' : ' down')

  const version = snap.capability?.version || '?'
  const apps = snap.catalog?.total ?? '?'
  const anchored = snap.catalog?.anchored ?? '?'
  const peers = snap.peerCount ?? 0
  const uptimeMin = snap.uptimeMs ? Math.round(snap.uptimeMs / 60_000) : null
  const uptimeStr = uptimeMin != null ? formatUptime(uptimeMin) : '?'
  const running = snap.running ? 'running' : 'idle'

  const peersHtml = (snap.peers || []).map(p => {
    const name = KNOWN.get(p.pubkey)
    if (name && name === id) {
      // shouldn't happen — relays don't see themselves — but guard anyway
      return `<span class="pubkey self">${p.pubkey} (self)</span>`
    }
    if (name) return `<span class="pubkey">${p.pubkey} <em>${name}</em></span>`
    return `<span class="pubkey unknown">${p.pubkey}</span>`
  }).join('')

  const errsHtml = (snap.errors || []).length
    ? `<div class="errors">errors: ${snap.errors.map(e => `${e.endpoint} (${e.error})`).join(', ')}</div>`
    : ''

  const anchoredVsTotal = (snap.catalog?.total && snap.catalog?.total > 0)
    ? `<span class="apps-summary">${anchored}/${apps} anchored</span>`
    : ''

  div.innerHTML = `
    <div class="relay-header">
      <span class="relay-name">${escapeHtml(id)}</span>
      <span class="relay-meta">${snap.host} · ${snap.region} · v${escapeHtml(String(version))} · ${snap.capability?.identity || ''}</span>
    </div>
    <div class="stats">
      <div class="stat">
        <div class="stat-label">status</div>
        <div class="stat-value ${snap.up ? 'up' : 'down'}">${snap.up ? running : 'DOWN'}</div>
      </div>
      <div class="stat">
        <div class="stat-label">uptime</div>
        <div class="stat-value">${uptimeStr}</div>
      </div>
      <div class="stat">
        <div class="stat-label">peers</div>
        <div class="stat-value ${peers >= 4 ? 'up' : peers >= 2 ? 'warn' : 'down'}">${peers}</div>
      </div>
      <div class="stat">
        <div class="stat-label">apps</div>
        <div class="stat-value">${apps}</div>
      </div>
      <div class="stat">
        <div class="stat-label">anchored</div>
        <div class="stat-value ${anchored > 0 ? 'up' : 'warn'}">${anchored}</div>
      </div>
      <div class="stat">
        <div class="stat-label">operator</div>
        <div class="stat-value" style="font-size:0.85em">${escapeHtml(snap.operator || '?')}</div>
      </div>
    </div>
    <div class="peers">
      <div class="peers-label">connected peers (${peers})</div>
      ${peersHtml || '<span class="updated">none yet</span>'}
    </div>
    ${errsHtml}
  `
  return div
}

function formatUptime (mins) {
  if (mins < 60) return mins + 'm'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h < 24) return `${h}h ${m}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

bootConfig().then(refresh)
setInterval(refresh, REFRESH_MS)
