# What's in the Relay (HiveRelay 0.8.0)

A guided tour of every component the relay picks up when it upgrades from
the pre-custody, pre-AutoHeal era (`b119e61`) to the v0.8.0 release
(`85c4f93`). Each section explains what the component is, why it exists,
and what it does for the network.

If you only read one document, read the [Atomic Blind Custody
whitepaper](./ATOMIC-BLIND-CUSTODY.md) first — it covers the protocol
that anchors most of these additions. This document focuses on the
relay implementation: how the parts fit together once they're running.

---

## 1. Atomic Blind Custody (Codex's contribution)

The relay now speaks a six-message custody protocol — intent → receipt
→ commit → source-retired → proof → non-serving-proof — implemented in
`packages/core/core/custody-signing.js`. Every custody-relevant event is
a signed Ed25519 envelope appended to the registry's append-only
Hypercore log, replicated network-wide. Privacy invariants are enforced
at the validator level: ten plaintext field names (`dataKey`,
`decryptionKey`, `plaintext`, `fileName`, etc.) are hard-blocked at
sign time. The relay can never accidentally pass through a key or a
filename in a custody message because the function throws before
producing a signature.

The custody pipeline runs as a state machine. A publisher signs an
intent declaring the encrypted ciphertext root, the replication target,
and the retention window. Each anchoring relay auto-emits a signed
receipt the moment it finishes anchoring. When `requiredReplicas`
receipts accumulate, the publisher signs a commit. The commit's
`receiptRoot` is a deterministic order-invariant hash over the relay
quorum's receipts; observers verify quorum without consensus on receipt
arrival order. The publisher then signs a source-retired entry,
relinquishing authority over future state. From that moment on,
clients refuse to accept further state-change signatures from the
retired authority key.

In practice this means an app can hand off encrypted content to a
quorum of relays with cryptographic proof of who took custody when,
under what retention window, with the source's authority retired —
and at no point does any relay see plaintext or decryption keys.

## 2. Witness Tombstone role

Storage replication alone cannot detect a relay that secretly continues
serving content past `retainUntil`. Simulation showed this leak
running 27%–82% across configurations. The Witness Tombstone role
closes it: independent witnesses probe a relay's catalog, gateway, and
swarm after expiry, then sign a `custody-expiry-witness` entry over
what they observed. Witnesses do not store content — they only attest
to relay state. A 5-of-7 witness quorum drops undetected continued
serving from approximately 82% to less than 1%, with no availability
cost.

This introduces a third role to the network — alongside publisher and
custody relay — that lets lightweight operators participate in the
trust pipeline without committing storage capacity. The relay's
implementation surfaces witness state through `custodySnapshot`
(reporting `withWitnessTombstone` and `totalWitnessTombstones` counts),
exposes a dedicated `POST /api/custody/<intentId>/witness` REST
endpoint, and wires the witness type through the
`hiverelay-custody` Protomux channel for real-time fan-out.

## 3. AutoHeal — diversity-enforced replica recruitment

AutoHeal is a background scheduler that watches archive-tier drives
(`durability: 1`) and recruits the local relay as a fresh replica when
doing so would meaningfully restore diversity. It runs every 30
minutes by default, reuses the federation's peer-catalog data (no new
wire traffic), and decides based on a three-path gate: the relay
recruits if it closes a region gap, closes an operator gap, or fills
the buffer slots when both diversity dimensions are already met.

The novelty is that AutoHeal counts only cryptographically verified
peers. A peer claiming `anchored: true` in its catalog is not enough;
the peer must produce a fresh signed Ed25519 anchor proof from its
`/api/anchors/<appKey>/proof` endpoint within the freshness window
(default 1 hour). This raises the bar from "they say they have it"
to "we cryptographically confirmed they had it within the last hour."
Without the proof, a peer doesn't count toward replica diversity
regardless of what its catalog claims.

A `replicaBuffer` of +2 over `minReplicas` lets AutoHeal recruit past
the SLO floor so transient offline dips don't immediately violate the
threshold. A per-operator `fairshareCap` of `ceil(target / minOperators)`
prevents any single operator from dominating a drive's replica set —
defense-in-depth against sybil clusters that share an operator
identity. A `maxProofsPerTick` budget of 64 caps the O(K·N)
proof-fetch cost on large fleets; deferred peers are picked up over
subsequent ticks. The cumulative effect: the SLO floor held 100% of
ticks at 2% per-tick churn in simulation, up from 28% pre-buffer.

## 4. `hiverelay-anchor` Protomux channel

Anchor proofs were originally delivered over HTTPS at
`/api/anchors/<appKey>/proof`. That works for relays exposing public
HTTP endpoints but breaks on pure-swarm fleets and NAT'd peers that
have no reachable HTTPS port. The new `hiverelay-anchor` Protomux
channel solves this by routing proof requests over the existing
Hyperswarm connection. AutoHeal prefers the channel when it's open and
falls back to HTTPS for legacy peers.

Wire encoding is 4-byte length-prefixed JSON, identical to the services
protocol. The channel supports three message types: REQUEST, RESPONSE,
ERROR. Each request is matched to its response by an integer id.
Pending requests have a 5-second timeout. The relay's
`createAnchorProof()` method is the single source of truth for proof
generation — both the HTTP endpoint and the Protomux handler call into
it, so an operator-driven config change to one path applies to the
other automatically.

What this means for the network: the relay can verify peers without
depending on HTTPS reachability. Pure-DHT deployments work. NAT'd
relays work. The trust pipeline is fully P2P at the protocol layer.

## 5. `hiverelay-custody` Protomux channel

Custody entries — intents, receipts, commits, retirements, proofs,
non-serving-proofs, witness tombstones — are durable because they're
appended to the registry's Hypercore log and replicated network-wide.
But Hypercore replication carries seconds-to-minutes latency. For
interactive flows ("I just signed a receipt; please count my vote
toward quorum NOW"), the relay also pushes new custody entries over a
dedicated `hiverelay-custody` Protomux channel.

Each connected peer receives the entry immediately. The receiver
applies it through the registry's `_applyPushedEntry` method, which
runs the same validation, dedup, and event-emission logic as
log-replicated entries — pushed entries do not touch the local log.
Hypercore replication remains the durable backstop; the channel is
just the fast-path for already-connected peers. If a push doesn't
reach a peer (network drop, channel not open), the next replication
cycle catches up.

Operationally, this means custody quorum convergence is measured in
milliseconds for connected peers and seconds for newly-connected
peers, instead of always being bound by the log replication tick.

## 6. Two-plane storage architecture

The relay now distinguishes two storage classes with different
semantics:

The **Persistent Availability Plane** (`storageClass: 'persistent'`,
`availabilityClass: 'always-on'`) handles Pear apps, public drives,
package mirrors, routing services. AutoHeal recruits replicas, the
relay catalogs the entries publicly, content is cataloged and repaired.
This is the right path for content that should stay online indefinitely.

The **Atomic Blind Custody Plane** (`storageClass: 'temporary'`,
`availabilityClass: 'atomic-handoff'`) handles encrypted file handoffs,
blind dead drops, time-bounded transfers. Entries are TTL-bounded by
`retainUntil`, the catalog redacts metadata, the relay processes
ciphertext only, and after expiry the entry is removed from active
serving and the relay can sign a non-serving-proof.

A relay can run both planes simultaneously. The two planes share the
same Hyperswarm connection, the same registry log, the same Protomux
channel inventory. They differ in lifecycle, default privacy posture,
and which scheduler watches them (AutoHeal vs custody expiry monitor).

## 7. Custody Expiry Monitor

A background scheduler runs every 60 seconds (configurable via
`custodyExpiryInterval`). It scans the local app registry for
temporary-custody entries whose `retainUntil` has elapsed past an
optional `custodyExpiryGraceMs`. Expired entries are unseeded —
removed from the local app registry, dropped from active swarm
serving, and the gateway returns "Drive not seeded on this relay" for
them. The relay emits a `custody-expired` event for each one.

After unsealing, the relay can produce a signed `custody-non-serving-proof`
for the intent — its own attestation that catalog and swarm-serving
state changed at expiry. Independent witnesses can then probe and sign
their own tombstones.

Operationally this is the mechanical guarantee that backs `retainUntil`.
An app sets a 24-hour retention window; the relay's monitor sees the
window elapse, unseeds, and emits the proof. The retention isn't a
configuration suggestion — it's enforced state.

## 8. Seed Revocability commitments

Publishers can now commit at seed time:

- `revocable: false` — promise the seed will not be unseeded.
- `unseedFreezeMs` — minimum cooldown before any unseed takes effect.

Both fields are covered by the seed signature in a 40-byte signed
payload (with v1 backward-compat for older seeds). Once a publisher
seeds with `revocable: false`, that commitment is cryptographically
verifiable — they cannot retroactively unseed without producing a new
signed seed entry and going through the cooldown. Archive-tier drives
(`durability: 1`) are non-revocable by definition.

This sits underneath atomic custody and AutoHeal in the trust stack.
AutoHeal recruits non-revocable archive replicas, knowing they cannot
be silently dropped; atomic custody intents reference encrypted
content that the publisher has committed to retain through the
retention window.

## 9. Live Telemetry — WebSocket Dashboard Feed

The dashboard feed at `/ws` (which existed since v0.5.0 for relay
stats) now broadcasts two new payload blocks:

`payload.autoHeal` exposes the per-drive diversity scorecard —
replicas, regions, operators, threshold status, recruit backoffs, proof
cache size, and the drive list (capped at 50 entries to keep frame
size bounded). A dashboard subscriber sees archive durability state in
real time.

`payload.custody` exposes the aggregate custody snapshot — total
intents, intents that reached quorum, intents committed, intents with
non-serving-proofs, intents with witness tombstones, plus a derived
`commitRate` health indicator. A dashboard subscriber sees whether the
custody trust pipeline is converging or stalling.

Ten new events trigger immediate (debounced 1-second) push, instead
of waiting for the 2-second tick: `auto-heal-recruited`,
`auto-heal-error`, `auto-heal-proof-failed`, `auto-heal-throttled`,
and the six custody bubble events (`custody-intent`, `-receipt`,
`-commit`, `-proof`, `-retired`, `-non-serving-proof`,
`-expiry-witness`). Operators monitoring a fleet see custody and
durability state changes as they happen, not on the next tick.

## 10. Client SDK Custody Methods

The `HiveRelayClient` SDK now exposes seven custody methods:
`publishCustodyIntent`, `publishCustodyCommit`,
`publishSourceRetired`, `recordCustodyProof`,
`recordCustodyNonServingProof`, `recordCustodyExpiryWitness`, and
`getCustodyStatus`. Each posts to the corresponding REST endpoint with
the relay's API key for write operations.

Apps can now drive the entire custody protocol from the SDK without
touching REST directly. The expected pattern: publish an intent, mark
the drive as `blind: true` with the intent ID when seeding, poll
`getCustodyStatus` until quorum is reached, sign the commit, sign
source-retirement, optionally schedule witness probes after
`retainUntil`. Apps that already use `client.seed()` get the
persistent-availability path; apps that need atomic custody add four
to six SDK calls.

## 11. Anchor proof generation as a first-class method

`RelayNode.createAnchorProof(appKey)` is now a public method on the
relay node. It builds the canonical signed payload over
`(tag || appKey || version || attestedAt || anchored_flag)`, signs
with the relay's identity Ed25519 secret key, and returns the proof
shape that any verifier accepts. Both the HTTPS endpoint and the
Protomux anchor channel call into it.

This is a small refactor with a meaningful consequence: anchor proofs
are now a primitive that any future code path can use. A client
wanting to verify a relay's claim can request a proof; a service-layer
plugin wanting to gate behavior on anchor state can ask the relay
directly; an operator running a CLI tool can produce proofs from
scripts. Previously the proof generation was inlined in the HTTP
handler, accessible only through HTTPS.

## 12. Operator field in catalogs and federation

The catalog endpoint at `/catalog.json` now surfaces a `region` field
(was already populated internally) and an `operator` field. Federation
polling reads both into each `peerCatalog` entry, and AutoHeal uses
them for operator-diversity scoring.

For a deployment to get the full sybil-resistance benefit, each
operator should declare their identity in `node.config.operator` —
a stable string like `"acme-corp"` or `"foundation-prod"`. Without
it, AutoHeal falls back to treating each pubkey as its own operator,
which preserves backward compatibility with v0.7.x catalogs but
defeats the per-operator fairshare cap.

## 13. Registry custody event bubbling

Custody events emitted by `SeedingRegistry` (`custody-intent-published`,
`custody-receipt-recorded`, etc.) are bubbled up to the `RelayNode`
event emitter under normalized names (`custody-intent`,
`custody-receipt`, etc.). The WS feed subscribes to the normalized
events, the dashboard sees uniform names, and downstream consumers
don't need to track verbose registry-internal naming. Both
log-replicated and channel-pushed entries fire the same bubbled events
through `_applyPushedEntry`, so downstream consumers don't have to
distinguish transports.

## 14. Two new test surfaces

The release adds two test categories that didn't exist before:

**Channel unit tests.** `test/unit/anchor-channel.test.js` (8 tests)
and `test/unit/custody-channel.test.js` (8 tests) cover the
request/response state machine, dedup logic, error paths, destroy
cleanup, and event emissions for both new Protomux channels.

**End-to-end integration test.** `test/integration/blind-custody-e2e.test.js`
spins up three real `RelayNode` instances on a Hyperswarm testnet,
runs the full custody pipeline through real signing, log replication,
anchoring, retention expiry, post-expiry non-serving-proofs, and
witness tombstones. 19 assertions, all green. This test catches
integration regressions that unit tests cannot — protocol channel
wiring, registry replication latency, expiry monitor side effects,
gateway behavior at retainUntil.

The combined v0.8.0 trust-stack bundle (auto-heal, custody-signing,
registry-custody, seed-revocability, seeding-registry-hardening,
ws-feed-payload, anchor-channel, custody-channel, client-custody)
runs 91 unit tests plus the E2E test, all passing.

## 15. Two simulation harnesses

Beyond unit and integration tests, the release ships two simulation
tools:

**`scripts/simulate-blind-atomic-custody.js`** is a Monte Carlo
analytic model that runs 5,000 trials per scenario across a 72-relay,
16-operator, 7-region simulated network. It produces the protocol's
statistical properties — commit rate, availability, adversary
reconstruction risk, post-expiry detection rate. This is the
simulation that surfaced the witness tombstone primitive as the
highest-leverage next addition.

**`scripts/simulate-auto-heal-bridge.js`** drives the real `AutoHeal`
class against an in-memory simulated network with 7 deterministic
scenarios (cold-start, sybil attack, liar attack, churn at four
different rates, stampede, partition heal, proof-fetch scaling). It
runs in under a second and is rerun on every behavioral change to
catch regressions in the recruit gate logic.

These are not unit tests — they're empirical evidence for protocol
design choices. The simulation results are referenced in the
whitepaper's Section 6 and inform the production-recommended
parameters.

## 16. DHT recoverable timeout fix

A small but consequential change: `DHTError REQUEST_TIMEOUT` is now
classified as recoverable, not fatal. Before this change, transient
DHT timeouts could crash the relay process, requiring systemd restart.
After, the relay logs the timeout and continues serving. The fix is
already deployed to all three production VPS relays (it predates the
v0.8.0 cycle but is included in the v0.8.0 codebase since the relay
is leapfrogging from `b119e61` directly to v0.8.0).

## 17. Summary

The relay running v0.8.0 is the union of the persistent availability
plane (AutoHeal-managed archive durability with cryptographic peer
verification) and the atomic blind custody plane (publisher → custody
relay → witness handoff with quorum receipts and post-expiry
attestation). Both planes are fully P2P at the protocol layer — two
new Protomux channels close the HTTPS dependency that v0.7.x left
open. Both planes surface their state through the dashboard feed.
Both planes are covered by unit, integration, and simulation tests.
Both planes are usable from the client SDK.

The relay is no longer a "P2P pinning service that says it has your
content." It is a verifiable trust layer that can prove who took
custody, when, for how long, that they cryptographically demonstrated
custody at challenge time, and that they stopped serving when their
retention window ended — all without ever decrypting the content.
