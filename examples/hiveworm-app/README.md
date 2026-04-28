# HiveWorm — peer-to-peer browser game

A perpetual P2P life-sim that runs entirely in the browser. You're a worm
in a 2D meadow. Eat dots to grow. Crash into another worm and you die.
One move per worm every five seconds.

HiveWorm has **no backend**. It uses
[`window.pear.swarm.v1`](https://github.com/holepunchto/pearbrowser-desktop/blob/main/docs/SWARM-V1.md)
when it detects PearBrowser Desktop v0.3+, and falls back to single-player
local mode in any other browser.

## What's in the bundle

```
index.html         page shell, viewport, mount point
game.js            entry — wires identity + network + world + renderer
network.js         peer gossip via window.pear.swarm.v1
identity.js        ed25519 keygen + localStorage + backup/import
schema.js          canonical signing + helpers
worm.js            client Worm: rendering + interpolation + color
world.js           tracks worms + food, applies entries, deterministic seeding
renderer.js        Canvas2D draw routines
input.js           keyboard + touch + cooldown gate
audio.js           synthesized SFX over WebAudio
config.js          biome key + tuning constants
style.css          saturated 90s-cartoon aesthetic
package.json       single dep: @noble/ed25519
```

No build step. Pure ES modules. The only runtime download is
`@noble/ed25519`, loaded from `unpkg.com` via `import`.

## Running it

### In PearBrowser (multiplayer)

The game uses `window.pear.swarm.v1` for direct peer-to-peer when running
inside PearBrowser Desktop v0.3+. Stage the bundle as a Hyperdrive,
then open the resulting `hyper://…` URL:

```bash
cd examples/hiveworm-app
pear stage default .
# → drive key: hyper://abc123…/
```

Open that URL in PearBrowser. Open it again on another machine (or on the
same machine in another window) — both peers join the same drive-derived
swarm topic and start gossiping moves. No relay, no server.

### In a regular browser (single-player)

Any static server works:

```bash
cd examples/hiveworm-app
python3 -m http.server 8080
```

Open `http://localhost:8080`. The game detects no swarm.v1 and runs in
local mode — one worm, deterministic food layout, no peers. Fine for
visual smoke-testing; multiplayer needs PearBrowser.

## Biome key

A biome is a 32-byte hex string. It seeds:

- The drive-derived swarm topic (so all peers on the same biome find each other)
- The deterministic food layout (so all peers see the same dots in the same places)

Default biome is `…0001`. Override via `?biome=<64-hex>`:

```
hyper://<drive-key>/?biome=00000000…0042
```

## Identity & backups

- The browser generates a fresh ed25519 keypair on first launch and
  persists it in `localStorage` under `hiveworm/identity/v1`.
- There's no password. If localStorage is wiped, the worm is gone.
- Click **backup** to download a `.json` file containing the seed.
- Click **import** to restore from a backup file. WARNING: this
  replaces the current worm permanently.

## Controls

- Arrow keys or WASD to move (one cell per press)
- 5-second cooldown between moves
- `M` toggles audio mute
- On touch devices, a directional pad appears in the lower-right

## Architecture notes

- **Pure P2P.** Each browser maintains its own world view by replaying
  signed entries received over the swarm. There's no authoritative server.
- **Deterministic food.** FNV-1a hash of the biome key + (x, y) decides
  food placement. All peers agree on the layout without coordination.
- **Late joiners.** When you connect to a peer, you ping them with a
  `sync-req`; they respond with a `snapshot` of their current world. You
  apply incoming `entry` messages from there.
- **Optimistic rendering.** Your moves apply locally before any peer sees
  them, so input feels instant. Conflict resolution is "first observed
  wins" — the worm-collision rule means deeply contentious moves still
  produce consistent outcomes.

## Bundle size

The full bundle is under 250 KB unminified. Largest file is `renderer.js`
at ~38 KB (procedural food sprites). The only runtime download is
`@noble/ed25519` (~5 KB gzipped).
