# HiveRelay 0.8.0 — Atomic Custody · Self-Healing · Live Telemetry · Real-Time P2P

Released: 2026-05-04

This is the first **0.8.x** minor — the largest semantic shift since 0.5.0
(Core/Services split). The trust pipeline that was implicit in earlier versions
is now cryptographically gated, replicas are diversity-enforced and
self-healing, propagation is real-time over Protomux (no HTTPS dependency),
and the WebSocket dashboard feed surfaces all of it.

Two new Protomux channels close the gap that v0.7.x left open:
- `hiverelay-anchor` — AutoHeal proof requests over the existing swarm
  connection (works on pure-swarm and NAT'd fleets, no HTTPS required)
- `hiverelay-custody` — push semantics for custody entries; receivers
  apply them immediately rather than waiting for log-replication latency

The Witness Tombstone role lands too — independent non-storage attestation
that closes the post-expiry serving leak surfaced by the simulation.

If you operate a relay or build on the client SDK, read the **Migration**
section below before upgrading.

For the full protocol specification, see the
[Atomic Blind Custody whitepaper](./ATOMIC-BLIND-CUSTODY.md).
For a tour of every component the relay picks up at v0.8.0, see
[What's in the Relay](./WHATS-IN-THE-RELAY.md).

---

## Headline features

### 1. Atomic blind custody (default)

Replication trust no longer rests on peer self-reports. Every replica that
counts toward an archive drive's diversity score must produce a recently
verified Ed25519 signature over `(tag || appKey || version || attestedAt ||
anchored_flag)` from its `/api/anchors/<appKey>/proof` endpoint.

The full custody pipeline lands as a first-class registry concept: signed
intent → receipt → commit → retired → proof → non-serving-proof, with quorum
gating and out-of-order-receipt support. See `packages/core/core/custody-signing.js`
and `docs/atomic-network-design.md` for the full design.

### 2. Self-healing replica recruitment (AutoHeal v2)

A diversity-aware scheduler runs in every relay (opt-in via
`config.autoHeal.enabled`). It reuses the federation peer-catalog data — no
new wire traffic — and recruits the local relay as a fresh replica when
doing so closes a region or operator gap.

What's new in 0.8.0 over the v1 ship in 0.7.x:

- **Cryptographic peer verification** — counts only proof-verified replicas
- **Replica buffer** — `target = minReplicas + replicaBuffer` (default +2),
  so transient offline dips don't drop the network below SLO
- **Operator diversity** — catalogs now expose `operator`; sybil clusters
  sharing one operator are bounded at the per-operator fairshare cap
  (`ceil(target / minOperators)`)
- **Proof-fetch budget** — `maxProofsPerTick` (default 64) caps O(K·N)
  traffic on large fleets; deferred peers are picked up over subsequent ticks
- **Three-path recruit gate** — region-gap / operator-gap / buffer-pad,
  each with explicit reason in the `recruited` event

### 3. Live telemetry — WebSocket dashboard feed

The dashboard `/ws` upgrade path now broadcasts:

- `payload.autoHeal` — diversity scorecard, threshold status, backoffs,
  proof cache size, drives list (capped at 50 per frame)
- `payload.custody` — aggregate intent count, quorums met, commits, proofs,
  non-serving-proofs, derived `commitRate`

Eight new events trigger immediate (debounced 1s) pushes:
`auto-heal-recruited`, `auto-heal-error`, `auto-heal-proof-failed`,
`auto-heal-throttled`, `custody-intent`, `custody-receipt`, `custody-commit`,
`custody-proof`, `custody-retired`, `custody-non-serving-proof`.

### 4. HiveWorm extracted

The relay core no longer ships HiveWorm — it's a separate showcase app.
Removed: `packages/core/core/hiveworm/*`, `packages/core/core/relay-node/hiveworm-ws.js`,
and associated tests. Relay core is now strictly relay infrastructure.

### 5. Seed revocability

Publishers can commit at seed time:
- `revocable: false` — promise the seed will not be unseeded
- `unseedFreezeMs` — cooldown before any unseed takes effect

Both fields are covered by the seed signature (40-byte signed payload, v1
backward-compat). Archive-tier drives are non-revocable by definition.

### 6. DHT recovery hardening

`DHTError REQUEST_TIMEOUT` is now classified as recoverable (was: fatal).
Already deployed to all 3 production VPS relays.

---

## Numbers

- 19 commits (+ 4 follow-up commits for 0.8.0 wiring)
- 64 files changed: **+8,468 / −2,029** (net +6,439)
- New modules: `anchor-proof-verifier.js`, `custody-signing.js`,
  `auto-heal.js` (635 lines)
- Removed modules: 9 HiveWorm files (~1,728 lines)
- New tests: ~1,800 lines across `auto-heal.test.js`, `custody-signing.test.js`,
  `registry-custody.test.js`, `seed-revocability.test.js`,
  `seeding-registry-hardening.test.js`, `ws-feed-payload.test.js`
- New simulation tooling: `simulate-blind-atomic-custody.js` (558 lines),
  `simulate-auto-heal-bridge.js` (604 lines)
- New design docs: `atomic-network-design.md` (903 lines),
  `ATOMIC-CUSTODY-SIMULATION.md`, `PROJECT-FOCUS-AND-BLOAT-AUDIT.md`

## Verified test status (this release)

| Bundle | Tests | Result |
|---|---|---|
| `auto-heal.test.js` | 32 | 32/32 pass |
| `custody-signing.test.js` | 2 | 2/2 pass |
| `registry-custody.test.js` | 3 | 3/3 pass |
| `seed-revocability.test.js` | 11 | 11/11 pass |
| `seeding-registry-hardening.test.js` | 4 | 4/4 pass |
| `ws-feed-payload.test.js` (new) | 6 | 6/6 pass |
| `api-auth.test.js` | 15 | 15/15 pass |
| `federation-hardening.test.js` | 16 | 16/16 pass |
| `catalog-envelope.test.js` | 16 | 16/16 pass |
| **Total v0.8.0 trust-stack** | **105** | **105/105 pass, 0 failures** |

Both simulation harnesses run cleanly. Lint clean across all changed files.

---

## Migration from 0.7.x

### Behavioral defaults that changed

1. **`verifyProofs: true` by default in AutoHeal.** A peer's `anchored: true`
   self-report is no longer enough — they must produce a valid signed proof.
   Existing relays running 0.7.x continue to emit proofs (the
   `/api/anchors/:appKey/proof` endpoint shipped in 0.7.x). If you mix 0.6.x
   relays into a 0.8.x deployment, set `config.autoHeal.verifyProofs: false`
   for staging/testnet.

2. **`replicaBuffer: 2` by default.** AutoHeal now recruits to
   `minReplicas + 2`, not just `minReplicas`. Existing networks will see
   slightly more recruitment after upgrade until they reach the new target.

3. **`maxPerOperator: ceil(target / minOperators)` by default.** Networks
   dominated by 1–2 operators may be unable to reach target. Override with
   `thresholds.maxPerOperator: 0` to disable the cap.

### What you should set in your config

Add to `node.config`:

```json
{
  "operator": "your-org-name",
  "regions": ["NA"],
  "autoHeal": {
    "enabled": true,
    "thresholds": {
      "minReplicas": 7,
      "minRegions": 4,
      "minOperators": 5,
      "replicaBuffer": 2
    },
    "verifyProofs": true,
    "proofFreshnessMs": 3600000,
    "maxProofsPerTick": 64
  }
}
```

The `operator` field at the top level is **important** — without it, AutoHeal
treats each pubkey as its own operator and the per-operator fairshare cap
becomes meaningless (no sybil resistance).

### New events to subscribe to

If you build dashboards or monitoring, the relay node now emits:
- `auto-heal-recruited` `{ appKey, before, reason }` — `reason` is one of
  `region-gap` / `operator-gap` / `replica-gap`
- `auto-heal-proof-failed` `{ appKey, peerPubkey, reason }`
- `auto-heal-throttled` `{ candidates, budget, deferred }`
- `custody-intent`, `custody-receipt`, `custody-commit`, `custody-proof`,
  `custody-retired`, `custody-non-serving-proof`

The WS feed at `/ws` now includes `autoHeal` and `custody` blocks in every
broadcast payload — no extra subscription needed.

### Removed

- HiveWorm — install separately if you need it
- AutoHeal v1 telemetry-only fields (now superseded by snapshot block)

---

## Known non-goals (deferred to 0.9.x)

- `_fleet` persistence — AutoHeal state is in-memory; rebuilt within one tick
  from federation cache after restart
- Operator-clustering auto-detection — manual `operator` field is respected,
  but auto-detecting "these distinct operators share infrastructure" is not
- Active health challenges — proof bridge is passive

---

## Acknowledgements

This release is the convergence of two parallel work streams:

- **Atomic Blind Custody** — the cryptographic trust pipeline (Codex)
- **AutoHeal** — diversity-enforced replica durability + the proof bridge
  that ties the two systems together

Plus cross-cutting hardening on registry auth, service peer roles, seed
admission, and the DHT recovery fix already on production.
