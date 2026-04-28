// HiveWorm browser config
//
// HiveWorm runs entirely in the browser. In PearBrowser desktop v0.3+ it
// uses window.pear.swarm.v1 to talk peer-to-peer with other players.
// In any other browser it falls back to single-player local mode.
//
// There is no "relay" config anymore — HiveWorm is just a static bundle
// that gets seeded onto the network like any other Hyperdrive.

export const config = {
  // 32-byte (64 hex char) biome key. Each biome is its own meadow with
  // its own food layout (deterministic from this key) and its own
  // multiplayer swarm topic. Change this to spin up a fresh world.
  defaultBiome: '0000000000000000000000000000000000000000000000000000000000000001',

  // Render constants
  cellSize: 24,
  viewportPadding: 60,

  // Move cooldown — must match the cooldown used by every peer on this
  // biome, otherwise validation will reject moves that arrive "too soon"
  // by one peer's clock.
  moveCooldownMs: 5000,

  // Viewport behavior
  cameraInertiaMs: 150,
  segmentInterpolationMs: 250,

  // Audio
  defaultMuted: false,

  // World defaults — until a snapshot from a peer overrides them.
  worldWidth: 200,
  worldHeight: 200
}

// Allow overriding via URL query string for quick experiments.
//   ?biome=abc123…    — use a different biome
//   ?backup=1         — force a backup prompt on load
function parseQuery () {
  if (typeof window === 'undefined') return {}
  const out = {}
  const sp = new URLSearchParams(window.location.search)
  if (sp.get('biome')) out.defaultBiome = sp.get('biome')
  if (sp.get('backup') === '1') out.promptBackup = true
  return out
}

Object.assign(config, parseQuery())
