// HiveWorm browser config
//
// All configuration the frontend needs lives here. Edit `relayBase` to point
// at your local relay (default: http://localhost:9100). Edit `defaultBiome`
// to start in a specific biome — for now this is a placeholder all-zero key.
//
// When you publish this bundle as a Hyperdrive, ship a built version with
// the real foundation biome key baked in (or read from a query string).

export const config = {
  // HTTP base of the relay this client talks to. The relay must be started
  // with `enableHiveworm: true` for the /api/hiveworm/* endpoints to work.
  relayBase: 'http://localhost:9100',

  // 32-byte (64 hex char) biome key. The "foundation biome" is an all-zero
  // placeholder so the bundle works out of the box against a fresh relay.
  // Replace with your operator's foundation key when shipping.
  defaultBiome: '0000000000000000000000000000000000000000000000000000000000000001',

  // Render constants
  cellSize: 24,
  viewportPadding: 60,

  // Network
  pollFallbackMs: 2000, // poll /state if WS unreachable
  reconnectDelayMs: 1500,

  // Move cooldown — must match relay's biome config (default 5s).
  // The relay is the source of truth; this is just so the UI can hint
  // at the cooldown without round-tripping a state fetch.
  moveCooldownMs: 5000,

  // Viewport behavior
  cameraInertiaMs: 150,
  segmentInterpolationMs: 250,

  // Audio
  defaultMuted: false,

  // World defaults — only used until /state arrives. After that the
  // server-derived config overrides these.
  worldWidth: 200,
  worldHeight: 200
}

// Allow overriding via URL query string for quick experiments without
// rebuilding. Examples:
//   ?relay=http://10.0.0.5:9100
//   ?biome=abc123...
//   ?backup=1   (forces a backup prompt on load)
function parseQuery () {
  if (typeof window === 'undefined') return {}
  const out = {}
  const sp = new URLSearchParams(window.location.search)
  if (sp.get('relay')) out.relayBase = sp.get('relay')
  if (sp.get('biome')) out.defaultBiome = sp.get('biome')
  if (sp.get('backup') === '1') out.promptBackup = true
  return out
}

Object.assign(config, parseQuery())
