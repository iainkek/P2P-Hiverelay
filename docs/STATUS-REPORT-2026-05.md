# HiveRelay Status Report — May 2026

A short, honest assessment of what the project is trying to do, what
we've delivered, what blockers we cleared along the way, and what
limitations we're still bumping into.

---

## What we're trying to achieve

A peer-to-peer relay network where **availability is provable, not
promised**. Three properties define the goal:

1. **Verifiable durability.** When a relay says it has your archive
   content, it can produce a fresh signed proof. When the network
   says ≥7 replicas across ≥4 regions are holding your drive, that
   claim is mechanically verified, not aggregated from self-reports.

2. **Encrypted custody handoff with cryptographic receipts.** A
   publisher hands an encrypted blob to a quorum of relays. Each
   relay signs a receipt over the exact ciphertext root. The publisher
   signs a commit + source-retirement. After expiry, relays sign
   non-serving-proofs and independent witnesses sign tombstones.
   Recipients can reconstruct the entire handoff from the registry
   log without trusting any single relay.

3. **Privacy by construction.** Relays never see plaintext, never
   see decryption keys. The validator hard-blocks ten plaintext field
   names so leakage is structurally impossible at the signing layer.

In short: be the storage layer for P2P apps that need more than
"trust me, I have it."

---

## What we've shipped

**v0.7.2 → v0.8.2** in roughly two weeks of focused work. Tagged and
deployed to all three production relays.

### Protocol-level

- **Atomic Blind Custody** — six signed message types (intent → receipt
  → quorum commit → source-retired → proof → non-serving-proof) plus
  Witness Tombstones. Full state machine, validator-enforced privacy
  invariants, registry log integration, REST + Protomux interfaces.
- **AutoHeal v2** — diversity-enforced replica recruitment with
  cryptographic peer verification, replica buffer for churn absorption,
  per-operator fairshare cap for sybil resistance, proof-fetch budget
  for scaling.
- **Two new Protomux channels** — `hiverelay-anchor` (proof requests
  over swarm, no HTTPS required) and `hiverelay-custody` (real-time
  push of custody entries between connected peers).
- **Witness Tombstone role** — independent non-storage attestation of
  post-expiry non-serving state. Simulation-proven to drop undetected
  continued serving from ~82% to <1%.

### Implementation

- 8 new packages of code (`anchor-proof-verifier`, `custody-signing`,
  `auto-heal`, `anchor-channel`, `custody-channel`, plus extensions to
  registry, relay-node, ws-feed, client SDK).
- 91 unit tests in the trust-stack bundle, all passing.
- 1 end-to-end integration test running 3 real relays on a Hyperswarm
  testnet through the full custody pipeline (19 assertions, green).
- 2 simulation harnesses — Monte Carlo analytic for protocol
  parameters, behavioral driver for AutoHeal regression detection.

### Documentation

- **`ATOMIC-BLIND-CUSTODY.md`** — formal whitepaper (threat model,
  state machine, security analysis, simulation evidence, comparison to
  Filecoin/Sia/Storj/IPFS).
- **`WHATS-IN-THE-RELAY.md`** — guided tour of every v0.8.0 component.
- **`TUTORIAL-CUSTODY-QUICKSTART.md`** — 10-minute developer
  walkthrough.
- **`RELEASE-NOTES-0.8.0.md`** + **`RELEASE-NOTES-0.8.1.md`**.
- **`HIVERELAY_OVERVIEW.md`** rewrite for v0.8.0 reality.
- **`M2-ROADMAP.md`** rewrite separating closed items from open ones.
- **`LOVABLE-LANDING-COPY.md`** — landing page copy.
- README + `THREAT-MODEL.md` updates.

### Production deployment

All three relays running v0.8.1+ on `0cf2735`:
- **Utah** (NA): operator `hive-foundation-utah`, AutoHeal+Custody
  enabled, 69MB memory.
- **Utah-US** (NA): operator `hive-foundation-utah-us`, AutoHeal+Custody
  enabled, 44MB memory.
- **Singapore** (AS): operator `hive-foundation-singapore`,
  AutoHeal+Custody enabled, 48MB memory.

API keys rotated to strong values on Utah and Singapore.

---

## Barriers we crossed

The work was not a straight line. Five non-trivial blockers along the
way, all worth documenting.

### 1. The trust gap

Pre-v0.8.0, AutoHeal counted any peer claiming `anchored: true` as a
live replica. A relay could lie or be compromised and inflate the
diversity score. **Crossed by:** building the anchor-proof verifier
(147 lines, Ed25519 signed payload over `tag || appKey || version ||
attestedAt || anchored_flag`) and gating AutoHeal's replica counting
on a fresh proof within a freshness window. Default freshness is 1
hour; cache window is freshness/2 to ensure between-tick validity.

### 2. HTTPS dependency

Initial implementation fetched proofs over HTTPS at
`/api/anchors/<appKey>/proof`. Worked for relays exposing public
HTTPS but broke on pure-DHT and NAT'd fleets. **Crossed by:** building
two Protomux channels (`hiverelay-anchor`, `hiverelay-custody`) that
ride the existing Hyperswarm connection. The trust pipeline is now
fully P2P at the protocol layer; HTTPS is a fallback, not a
prerequisite.

### 3. Reactive recruitment under churn

Simulation showed AutoHeal held its SLO floor only 28% of ticks at 2%
per-tick churn — because it stopped recruiting AT `minReplicas` and
any single offline replica broke threshold. **Crossed by:** adding
`replicaBuffer` (default +2 over min). After fix: held 100% of ticks
at 2% churn, 72% at 20% churn.

### 4. Operator-as-pubkey defeated sybil resistance

The first AutoHeal v2 implementation used pubkey as operator. 50
sybils with 50 pubkeys counted as 50 distinct operators — diversity
metric was a false positive. **Crossed by:** wiring a real `operator`
field through catalog → federation → AutoHeal scoring, plus a
per-operator fairshare cap (`ceil(target / minOperators)`) that
bounds any single operator from dominating a drive's replica set.
Sybil cluster of 50 in simulation now bounded to 2 host slots = the
cap.

### 5. Post-expiry serving leak

Storage replication alone leaves continued post-expiry serving
undetected at 27%-82% rates across configurations. The relay can
secretly keep serving after `retainUntil` and there's no way to
detect it from storage state alone. **Crossed by:** introducing the
Witness Tombstone — a third non-storage role that probes a relay's
catalog, gateway, and swarm and signs over what it observed. With
v0.8.1's hardening, witnesses must reference an actual indexed
non-serving-proof (closing the witness-forgery vector). Simulation:
5-of-7 witnesses drops undetected serving to <1% with no availability
cost.

### Operational blockers (smaller but real)

- The deploy script's systemd unit had pointed to `cli/index.js` since
  the v0.5.0 monorepo split (real path: `packages/core/cli/index.js`).
  Caused MODULE_NOT_FOUND on every fresh deploy. **Caught and fixed**
  during the v0.8.1 canary to Utah.
- Local git was authenticated as the wrong GitHub account (`iesetorg`
  instead of `bigdestiny2`). **Crossed by** switching `gh` active
  account and registering it as the credential helper for github.com.

---

## Where we're hitting limits

Honest accounting of what we cannot do, deliberately deferred, or
just haven't built yet.

### Cryptographic boundaries (cannot do on commodity hardware)

The whitepaper is explicit about this and we don't oversell:

- **Cannot prove a relay physically deleted bytes.** A relay can
  attest "I unseeded the entry from my catalog and I'm not serving it
  anymore," and witnesses can independently confirm that observed
  state — but neither can cryptographically prove disk erasure. A
  relay could keep a copy and serve it again later (witness tombstones
  catch the active part of this; the passive snapshot remains).
- **Cannot prove a publisher destroyed their data key.** Source
  authority retirement is logical, not forensic.
- **Cannot prove the absence of memory snapshots taken before
  deletion.**

These are the strong claim's hard limits. The path past them is
TEE/HSM-attested deletion, listed in the v0.9.x roadmap.

### Built but not yet wired into ops

- **Operator Score module** — operator field is wired through, but
  the full hard-gate / soft-gate scoring per the Engineering Brief
  isn't built.
- **Cryptographic geographic attestation** — `region` is still
  self-reported. ASN-based or latency-triangulation verification would
  make geography claims as solid as operator claims now are.
- **Witness reputation system** — witnesses caught colluding with
  custody relays should accumulate negative reputation. Protocol
  supports it; the loop isn't wired.
- **Cross-network witness federation** — protocol cryptographically
  supports it; deployment patterns aren't codified.

### Not built

- **TEE/HSM-attested deletion.** Hardest technical work, longest lead
  time. v0.9.x research item.
- **Independent alt-client.** Cannot be done in-house — requires a
  different team to implement the protocol from the spec. The
  whitepaper is the spec; outreach hasn't started.
- **Sybil layers beyond fairshare cap.** ASN/region uniqueness, signed
  Nostr notes, LN channel maturity, escrowed bonds — all spec'd, none
  built.
- **Bandwidth receipt verification.** Receipts are logged; verification
  challenge system isn't built.
- **P2P-Auth v1 spec.** Mnemonic + social-recovery + hardware-key +
  post-quantum migration — delegation primitive only today; full
  spec pending.

### Operational debt

- **Three-relay production network is small.** Sybil resistance,
  diversity guarantees, and the fairshare cap all assume the network
  is large enough that real diversity is achievable. At three relays
  the math holds but the absolute numbers are tight.
- **Utah-US still on the placeholder `hiverelay-secret` API key.** No
  strong key was provided for it during this rotation.
- **AutoHeal periodic ticks happen every 30 min by default.** No
  evidence yet of what real recruitment activity looks like in the
  3-relay production network — the live dashboard now exposes it but
  we haven't watched it across a full tick cycle yet.
- **Witness tombstones not yet exercised in production.** No custody
  intents have been published on the live network. The protocol works
  end-to-end in the integration test; production usage hasn't started.

---

## Production state, today

```
Relay        Commit    Status   Memory      AutoHeal   Custody    Operator
Utah         0cf2735   active   69M / 384M  enabled    enabled    hive-foundation-utah
Utah-US      0cf2735   active   44M / 1G    enabled    enabled    hive-foundation-utah-us
Singapore    0cf2735   active   48M / 512M  enabled    enabled    hive-foundation-singapore
```

Zero post-redeploy errors across all three. Memory comfortably under
caps. Peer connections established. Apps preserved across restarts.

---

## What's next, by priority

1. **Strong API key for Utah-US.** Two-minute fix; just needs the key.
2. **Watch the network through a full AutoHeal tick cycle.** First
   real-world signal of what archive-tier diversity scoring looks like
   in production.
3. **Publish a test custody intent on the live network.** First real
   end-to-end exercise outside the integration test.
4. **Add automatic operator-cluster detection.** Currently operators
   are honestly self-declared. Detecting "these distinct operators
   share AS / same datacenter / same upstream" is a meaningful
   hardening.
5. **Operator Score module + public dashboard endpoint.** First major
   v0.9.x deliverable. Inputs are mostly already collected; the
   calculation and public surface are not.

The protocol-level work for v0.8.x is done. The operational work for
v0.9.x is sequenced and documented in [M2-ROADMAP.md](M2-ROADMAP.md).
