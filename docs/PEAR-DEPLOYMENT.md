# Running HiveRelay as a Pear app

Operator install in one command, no Node.js, no npm, no Docker. The relay
itself is a Hypercore — atomic updates propagate over the same P2P network
the relay serves.

```bash
pear run pear://ofdo9m6myqg3u6cozz3izgemiaabwyynp3x8fgyh1o8nfomsj58o
```

That's it. The Bare-native relay starts, joins the public DHT, peers with
existing Node relays, and starts seeding content for any client that asks.

---

## What you get

| Feature | Pear-native (Bare) |
|---|:-:|
| Hyperswarm DHT discovery + peering | ✅ |
| Seed protocol (signed accept/replicate) | ✅ |
| Circuit relay (NAT traversal) | ✅ |
| App registry, federation, catalog sync | ✅ |
| Identity persistence across restarts | ✅ |
| Always-on availability for published drives | ✅ |
| Read-only HTTP endpoints (`/health`, `/status`, `/catalog.json`, `/api/peers`) | ✅ |
| Auto-updates via Hypercore (next `pear release` propagates to all running nodes) | ✅ |
| SwarmFirewall (DoS shield before Noise handshake) | ✅ |
| **Service RPC (identity, storage, schema, SLA, arbitration, ZK)** | ❌ Node-only — Bare relays are pure relay/seed |
| **Lightning payments (LNbits)** | ❌ Node-only |
| **Management TUI (`hiverelay tui`)** | ❌ Node-only |
| **Tor transport** | ❌ Node-only |

The split is intentional: **Bare = always-on data plane**, **Node = operator
control plane**. Most serious operators will run both — Node for configuring
the node and earning sats, Bare for the 24/7 hot path. The two runtimes
speak the same Protomux protocols and interop seamlessly on the DHT.

---

## Install

### One-time prerequisite

Install the Pear runtime (a one-liner from any Mac/Linux/Windows shell):

```bash
npm install -g pear
pear run pear://runtime
```

The second command initializes the Pear sidecar. After it runs once, Pear
is ready and you don't need it again.

### Run the relay

```bash
pear run pear://ofdo9m6myqg3u6cozz3izgemiaabwyynp3x8fgyh1o8nfomsj58o
```

Defaults: HTTP API on port 9100, region NA, 50 GB max storage, persistent
storage in Pear's app-storage directory.

### With options

```bash
pear run pear://ofdo9m6myqg3u6cozz3izgemiaabwyynp3x8fgyh1o8nfomsj58o \
  -- --port 9199 --region EU --max-storage 100GB
```

Args after `--` are forwarded to the relay.

### Persistent storage

By default, Pear allocates an `app-storage/by-dkey/<id>/` directory so
state (identity, app registry, seeded content) survives restarts. To pin
storage to a specific path:

```bash
pear run --store /path/to/relay-data pear://ofdo9m6myqg3u6cozz3izgemiaabwyynp3x8fgyh1o8nfomsj58o
```

---

## Verify it's working

While the relay is running:

```bash
curl http://127.0.0.1:9100/status     # node overview
curl http://127.0.0.1:9100/api/peers  # connected peers
curl http://127.0.0.1:9100/catalog.json  # what you're seeding
```

Status should report:
- `runtime: "bare"`
- `publicKey: <64 hex chars>` — your relay's identity
- `connections: <number>` — peer count from the DHT
- `seededApps: <number>` — drives you've accepted

---

## Upgrading

Auto-updates ship over the DHT. When the maintainer runs `pear release dev`
on a new version, every running node:

1. Pulls the update via Hypercore replication
2. Verifies it against the maintainer's signing key
3. Reaps the old process via `Pear.teardown`
4. Restarts on the new version

You don't need to do anything. Your data persists across the upgrade.

To pin to a specific version (avoid auto-update), use a version-pinned
link instead of the current one — `pear info dev` shows the format
`pear://0.<length>.<key>`.

---

## What can a Bare relay do for the network?

A Bare relay is a complete protocol participant:

- **Accepts and signs seed requests** from any HiveRelay client
- **Replicates seeded drives** to its Corestore for always-on availability
- **Bridges connections** for peers behind symmetric NAT (circuit relay)
- **Announces on the public DHT** so clients can discover it
- **Federates** with other relays via signed catalog sharing

A drive published by a Node client and accepted by a Bare relay is
retrievable by any Hyperswarm peer — even after the original publisher
goes offline, even if the only relay holding it is Bare. This was verified
end-to-end with a 3rd-party reader successfully reading the content with
the publisher offline. (See `scripts/bare-production-verify.mjs`.)

---

## What's missing vs the Node version

The following are deliberately **not** in the Bare build:

- **Service RPC layer** — Bare can register services in principle, but the
  standard built-ins (identity, storage, etc.) live in `p2p-hiveservices`,
  a Node-side workspace package not bundled into the Pear app today. A
  Bare relay running today is a pure seed/relay/circuit node, not a
  service host.
- **Lightning payments** — `@grpc/grpc-js` is Node-only.
- **Management TUI** — `@inquirer/prompts` is Node-only. Operator config
  happens via the Node CLI.
- **Tor transport** — the `socks` library is Node-only.
- **Management HTTP API** — Bare exposes only read-only endpoints. The
  full `/api/manage/*` routes are Node-only.

If any of these matter for your operator role, run the Node version
(`npm install -g p2p-hiverelay && p2p-hiverelay start`) instead. The two
runtimes interoperate on the DHT — running both side-by-side is fine.

---

## Storage layout (Bare)

```
<store>/
├── identity.key          ← Ed25519 seed (32 bytes hex)
├── primary-key           ← Corestore primary key
├── app-registry.json     ← Seeded drives metadata
├── federation.json       ← Federation peers
└── cores/                ← Corestore (hypercore content)
```

The same key files exist regardless of runtime. You can move between
Node and Bare runtimes by pointing each at the same storage directory.

---

## Verification

Run the full production verification suite from the repo:

```bash
git clone https://github.com/bigdestiny2/P2P-Hiverelay
cd P2P-Hiverelay
npm install

# In terminal 1 — boot the Bare relay
pear run pear://ofdo9m6myqg3u6cozz3izgemiaabwyynp3x8fgyh1o8nfomsj58o -- --port 9197

# In terminal 2 — verify
BARE_HTTP=http://127.0.0.1:9197 node scripts/bare-production-verify.mjs
```

Expected output: **`11/11 passed`** — protocol, mesh, seed, replication,
round-trip availability all green.

---

## Known limitations

- **Symlink in `packages/core/node_modules`** — when developing locally,
  the workspace symlink works for `pear run .` from `packages/core/`. For
  the published `pear://` link, deps must be resolvable from the staged
  Hypercore content; `pear stage` follows the symlink and bundles the
  resolved files.
- **Service RPC graceful degradation** — `p2p-hiveservices` is a workspace
  package not in `dependencies` of `p2p-hiverelay`, so Bare boots without
  it and logs `service start failed: <name>` warnings. The relay still
  works as a seed/circuit node.
- **First boot may take ~10s** to flush the DHT and find peers. Subsequent
  starts (with persistent storage) are faster.

---

## Reporting issues

If a Bare-specific bug surfaces, open an issue with:
- Output of `pear info dev` for the link you're running
- The first 30 lines of the boot log
- `curl http://127.0.0.1:<port>/status` output

The Bare relay shares ~85% of code with the Node relay — most bugs are
shared, but a few (Hyperdrive iterator lifecycle under Bare, bare-fs
edge cases, bare-http1 quirks) only manifest in the Bare runtime.

