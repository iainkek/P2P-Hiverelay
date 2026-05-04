# HiveRelay Project Focus And Bloat Audit

## Executive Assessment

HiveRelay's strongest product is now clear:

> HiveRelay keeps P2P apps, drives, and services reachable when normal peer availability fails, and adds blind atomic custody for temporary encrypted handoff.

That is the wedge. Everything else should either strengthen that wedge or move out of the default product path.

The project has also accumulated real feature gravity. This is normal for an ambitious P2P infra project, but the repo now contains several layers that should not all be treated as core relay functionality.

## Current Shape

Measured source/docs/test footprint, excluding `node_modules`, `.git`, and `tmp-audit2`:

| Area | Signal |
|---|---:|
| Source/doc/test files in main scope | 248 |
| Approx lines in main scope | 81,065 |
| Unit test files | 63 |
| Integration test files | 9 |
| Core files under `packages/core` | 61 |
| Service package files | 13 |

Largest local files:

| File | Lines | Risk |
|---|---:|---|
| `packages/client/index.js` | 2,906 | SDK god-file |
| `packages/core/core/relay-node/index.js` | 2,711 | Relay god-file |
| `packages/core/core/relay-node/api.js` | 2,278 | API god-file |
| `packages/core/cli/index.js` | 1,275 | CLI god-file |
| `docs/ECONOMICS.md` | 1,200 | Product narrative drift |
| `examples/hiveworm-app/renderer.js` | 1,141 | Example app complexity |
| `dashboard/docs.html` | 999 | Static dashboard sprawl |
| `dashboard/index.html` | 979 | Static dashboard sprawl |

The code is much stronger than it was, but the project is entering the phase where focus matters as much as capability.

## What Must Stay Core

These are the core HiveRelay product primitives.

| Area | Why It Belongs In Core |
|---|---|
| Hyperswarm/HyperDHT connectivity | This is the relay substrate |
| Persistent seeding | Main value prop: keep P2P content online |
| Circuit relay/NAT fallback | Makes P2P reachable under real network conditions |
| App/content registry | Discovery, replication coordination, catalog |
| Gateway | Browser/mobile preview for public content |
| Privacy tiers and access control | Prevents relay availability from becoming data leakage |
| Blind atomic custody | Differentiated feature, defensible wedge |
| Proof/custody signing | Trust and audit layer |
| Service supervision | Required if services are advertised at all |
| Minimal plugin loader | Lets advanced features exist outside the kernel |

If a feature does not reinforce availability, reachability, custody, discovery, or operator trust, it probably does not belong in core.

## Feature Creep Candidates

These are not bad ideas. They are just not the default product.

| Feature | Current Risk | Better Home |
|---|---|---|
| AI inference | Large security and ops surface; SSRF/sandbox/GPU concerns | Plugin package or separate operator tier |
| ZK poker/card primitives | Interesting but app-specific | App/plugin ecosystem |
| Arbitration service | Needs governance/economics/liability model | Future marketplace layer |
| SLA contracts | Useful later, but claims can outrun enforcement | Operator marketplace layer |
| Payments/credits/economics | Important, but not needed for proof of product-market fit | Optional billing module |
| Token model docs | Distracts from no-token infrastructure wedge | Archive or explicitly mark speculative |
| Multi-transport sprawl | Tor/Holesail/WebSocket are useful but increase support matrix | Adapter plugins with test contracts |
| Static dashboard pages | Useful demos, but easy to drift from reality | Thin admin UI generated from live APIs |
| Heavy examples | Good for demos, bad as core signal | Separate examples repo or `/examples` kept clearly non-core |
| HomeHive/private pairing | Valuable, but should not confuse public relay wedge | Product profile, not default relay identity |

The key discipline: these can exist, but they should not be enabled, marketed, or documented as equally mature with the relay/custody core.

## Product Kernel

The minimal product kernel should be:

```text
HiveRelay Kernel
  -> P2P reachability
  -> persistent content availability
  -> content registry/discovery
  -> public gateway
  -> blind atomic custody
  -> proof/status APIs
  -> operator health/supervision
```

Everything else should attach as:

```text
Plugins
  -> AI
  -> ZK
  -> arbitration
  -> SLA
  -> payments
  -> special transports
  -> app-specific services
```

This gives the project a clean answer to "what is HiveRelay?"

HiveRelay is not trying to be a decentralized cloud, AI platform, token economy, app store, dashboard suite, and arbitration court all at once.

HiveRelay is the always-on P2P availability and custody substrate that those things can use.

## Technical Refactor Priorities

### P0: Split RelayNode

`packages/core/core/relay-node/index.js` is too large and too important.

Extract managers:

| Manager | Responsibility |
|---|---|
| `CustodyManager` | intent/receipt/commit/proof/non-serving/witness flow |
| `SeedingManager` | seed/unseed, app lifecycle, anchoring |
| `ReplicationManager` | health, repair, replica policy |
| `ServiceManager` | service startup, supervision, plugin loading |
| `DiscoveryManager` | DHT/mDNS/federation discovery |
| `PaymentManagerAdapter` | optional settlement glue |

### P0: Split API Routes

`packages/core/core/relay-node/api.js` should be route modules:

| Module | Routes |
|---|---|
| `routes/catalog.js` | `/catalog.json`, `/api/apps`, discovery |
| `routes/seed.js` | `/seed`, `/unseed`, registry mutation |
| `routes/custody.js` | `/api/custody/*` |
| `routes/manage.js` | `/api/manage/*` |
| `routes/gateway.js` | `/v1/hyper/*` |
| `routes/dashboard.js` | static dashboard |

### P1: Define Product Profiles

The default profile should be boring and safe:

```js
profile: 'relay-core'
plugins: ['storage', 'identity']
payment.enabled: false
ai.enabled: false
arbitration.enabled: false
sla.enabled: false
zk.enabled: false
```

Suggested profiles:

| Profile | Purpose |
|---|---|
| `relay-core` | availability, gateway, registry |
| `custody-relay` | blind atomic custody |
| `homehive` | local/private relay |
| `service-operator` | opt-in app services |
| `experimental-lab` | AI/ZK/SLA/arbitration demos |

### P1: Move Claims To Capability Docs

Docs and website claims should come from actual live capability flags:

```json
{
  "availability": true,
  "blindCustody": true,
  "custodyExpiry": true,
  "expiryWitnesses": false,
  "payments": "experimental",
  "ai": "plugin",
  "arbitration": "plugin"
}
```

This prevents product drift.

## What To Build Next

The next high-leverage work is:

1. Implement `custody-expiry-witness` as the next atomic custody primitive.
2. Split custody code out of `RelayNode`.
3. Split API routes.
4. Add production profiles that keep advanced services disabled unless opted in.
5. Move AI/ZK/SLA/arbitration/payments documentation into an explicit plugins/experimental section.
6. Add a live capability endpoint that the website and dashboard can consume.

## Strategic Recommendation

Do not reduce ambition. Reduce surface area.

HiveRelay can still become the substrate for AI, poker, private data rooms, Ghost Drive, HomeHive, and operator markets. But the project should ship one sharp kernel first:

> Always-on P2P availability plus blind atomic custody.

That is differentiated, understandable, testable, and valuable right now.
