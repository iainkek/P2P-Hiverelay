# Roadmap — what's still required (post-v0.8.0)

*Tracker for security and trust-pipeline work specced in the
Engineering Brief. v0.8.0 closed the atomic custody and replica
durability gaps. This document tracks what's still ahead.*

---

## v0.8.0 status snapshot

The 0.8.x line shipped the trust-pipeline transformation. As of
v0.8.0, the relay is no longer "P2P pinning that says it has your
content." It is a verifiable trust layer with:

- Atomic Blind Custody — six signed message types, quorum receipts,
  source-authority retirement, possession proofs, non-serving-proofs
- Witness Tombstone role — independent post-expiry attestation
  (drops undetected continued serving from ~82% to <1%)
- AutoHeal v2 — diversity-enforced replica recruitment with
  cryptographic peer verification, replica buffer for churn
  absorption, per-operator fairshare cap for sybil resistance,
  proof-fetch budget for scaling
- Two new Protomux channels — `hiverelay-anchor` and
  `hiverelay-custody` — eliminating the HTTPS dependency for the
  trust pipeline
- Live telemetry — WS dashboard feed surfaces autoHeal + custody
  state, with immediate event push on every state change
- Client SDK custody methods — apps drive the full custody protocol
  from the SDK without REST plumbing
- E2E integration test — three real relays on a Hyperswarm testnet,
  full custody pipeline, 19 assertions
- 91 unit tests in the trust-stack bundle, all passing

For the complete picture, see
[WHATS-IN-THE-RELAY.md](WHATS-IN-THE-RELAY.md).

---

## Items closed by 0.8.x

| Item | Status | Notes |
|---|---|---|
| Atomic blind custody primitive | ✅ shipped (0.8.0) | 7 signed message types incl. witness tombstone |
| Witness Tombstone role | ✅ shipped (0.8.0) | Independent non-storage attestation |
| AutoHeal — diversity-enforced replica recruitment | ✅ shipped (0.7.x → 0.8.0 v2) | Cryptographic peer verification, fairshare cap, proof budget |
| Protomux anchor channel (no HTTPS dep) | ✅ shipped (0.8.0) | `hiverelay-anchor` |
| Protomux custody channel (real-time push) | ✅ shipped (0.8.0) | `hiverelay-custody` |
| Operator field through catalog → federation → AutoHeal | ✅ shipped (0.8.0) | Stable operator IDs for sybil resistance |
| Replica diversity (QuorumSelector) | ✅ shipped (0.6.0) | |
| Local fork detection during replication | ✅ shipped (0.6.0) | Auto via Hypercore events |
| Cross-replica fork detection | ✅ shipped (0.6.0) | `queryQuorumWithComparison` |
| Reference verifier package | ✅ shipped (0.6.0) | `p2p-hiverelay-verifier` |
| LNbits admin key encryption at rest | ✅ shipped (0.6.0) | AES-256-GCM |
| Capability doc signing + verification | ✅ shipped (0.6.0) | Tampering caught |
| Quarantine of forked drives in `open()` | ✅ shipped (0.6.0) | `DRIVE_QUARANTINED` until resolved |
| Audit trail for `force: true` bypasses | ✅ shipped (0.6.0) | |
| Fork-proof federation gossip | ✅ shipped (0.6.0) | |
| Pubkey pinning via knownRelays registry | ✅ shipped (0.6.0) | |
| Seed revocability commitments | ✅ shipped (0.7.x) | `revocable: false` + `unseedFreezeMs` |
| DHT timeout recoverable, not fatal | ✅ shipped (0.7.3) | |

---

## Open items for v0.9.x and beyond

These are the items still ahead. Effort and dependencies indicated.

### TEE/HSM-attested deletion mode

**Status:** ❌ scoped, no code
**Effort:** 1-2 months elapsed
**Dependencies:** TEE platform availability, attestation format
selection (Intel SGX / AMD SEV-SNP / Apple Secure Enclave)

The current protocol delivers logical source retirement and observed
non-serving state, not forensic erasure. A TEE-equipped relay could
provide cryptographic evidence of disk erasure. This is enumerated in
the whitepaper as an optional future extension. Not a v0.9.x blocker
for general use, but desirable for high-value flows.

### Witness reputation

**Status:** ❌ scoped, no code
**Effort:** 2 weeks
**Dependencies:** Per-relay reputation infrastructure (already
present); witness tombstone history (already indexed in registry)

Witnesses caught colluding with custody relays should accumulate
negative reputation. The protocol supports this cryptographically;
the application policy needs to be specified and the enforcement
loop wired through `ReputationSystem`.

### Cross-network witness federation

**Status:** ❌ scoped, no code
**Effort:** 2 weeks
**Dependencies:** None — protocol already supports it cryptographically

A witness on one HiveRelay deployment attesting to a relay on another
deployment is a useful primitive for cross-organizational audits.
Deployment patterns and federation policies are not yet codified.

### Operator Score module + public dashboard

**Status:** ⚠️ partially shipped — operator field is wired through
AutoHeal diversity scoring; full Operator Score module not built
**Effort:** 2-3 weeks
**Dependencies:** Engineering Brief §6.5

The Engineering Brief specifies hard-gate metrics (uptime, challenge
success, storage integrity, version currency) and soft-gate weights
(latency, bandwidth, NAT success, peer count, geo consistency,
served volume, churn resistance). Some inputs already collected
(uptime via health monitor, peer counts via federation pings); the
score calculation, public endpoint, and quorum-ranking integration
are not yet built.

### Sybil defense gates (multi-layer)

**Status:** ⚠️ partially shipped — per-operator fairshare cap covers
diversity layer; ASN/region uniqueness, Nostr signed notes, LN channel
maturity, escrowed bonds are not yet built
**Effort:** 2-3 weeks
**Dependencies:** OperatorScore module for challenge-success metric

The per-operator fairshare cap that landed in 0.8.0 is a strong
diversity layer (caps any single operator at fairshare slots per
drive). The remaining layers from the Engineering Brief (cross-relay
identity attestation, economic friction via channel maturity,
escrowed bonds for high-value writes) are independent additions.

### Merkle proof-of-retrievability challenges

**Status:** ❌ scoped, no code
**Effort:** 2 weeks
**Dependencies:** Verifier-node infrastructure

The custody-proof message type exists for ad-hoc challenges. A
systematic Merkle PoR challenge schedule would give continuous
storage-integrity attestation. Useful for high-value archive content.

### Cryptographic geographic attestation

**Status:** ❌ scoped, no code
**Effort:** 3-4 weeks
**Dependencies:** ASN-based + latency triangulation infrastructure

The current `region` field is self-reported. A relay claiming "I'm in
NA" is trusted. Latency triangulation across known reference points
plus ASN-based cross-checks would make geographic claims verifiable.

### Independently-authored alt-client

**Status:** ❌ outreach not started
**Effort:** 1-3 months elapsed
**Dependencies:** External team

Threat-model action #3. Cannot be done in-house — requires a
different team to implement the protocol from the spec. The whitepaper
(0.8.0) is the implementation-independent specification needed for
this.

### Bandwidth receipts that get challenged + verified

**Status:** ⚠️ logged but unverified
**Effort:** 2 weeks
**Dependencies:** Engineering Brief §6.5

The `proof-of-relay` channel attests to bandwidth served. Composing
it with periodic challenges + verification would close the
"reported bandwidth" → "verified bandwidth" gap.

### P2P-Auth v1 spec

**Status:** ⚠️ delegation primitive only
**Effort:** 1 month spec + council review
**Dependencies:** Engineering Brief §3.3

Mnemonic + social-recovery + hardware-key + post-quantum migration
path. The current implementation has delegation certs; the broader
spec is not yet drafted.

### Reproducible builds

**Status:** ❌ no code
**Effort:** 1 week
**Dependencies:** None — well-trodden territory

For supply-chain integrity. Pin all dependencies to specific hashes,
ship a `BUILD-REPRODUCIBLY.md` document, set up a CI matrix that
verifies hashes match across two independent build environments.

### Push notification specification

**Status:** ❌ research + spec
**Effort:** 1 month
**Dependencies:** Engineering Brief §3.5

Push semantics for P2P apps without leaking metadata to push providers.
Active research area; protocol selection (e.g., adaptation of OHttp,
PIR-based mailboxes) and reference implementation needed.

### Moderation/labeler protocol

**Status:** ❌ scoped, no code
**Effort:** 1 month spec + ref impl
**Dependencies:** Engineering Brief §3.5

For public content that needs moderation infrastructure without
centralized control. AT Protocol's labeler model is one reference;
HiveRelay's append-only registry log is a natural fit for signed
labels.

---

## Sequencing recommendation

For 0.9.x:

1. **TEE/HSM-attested deletion** — hardest technical work, longest
   lead time. Start research immediately.
2. **Witness reputation + cross-network federation** — short tasks,
   high leverage on the existing witness role.
3. **Operator Score module** — input to everything else (Sybil gates,
   quorum-ranking, payout eligibility).
4. **Cryptographic geographic attestation** — independent track,
   high-value for cross-region apps.
5. **External alt-client outreach** — non-engineering, parallel,
   cannot be rushed.

For later:

- Merkle PoR challenges (depends on OperatorScore for challenge-
  success metric)
- Bandwidth receipt verification (depends on OperatorScore)
- P2P-Auth v1 spec (pure spec, not blocked by code)
- Push specification (research-heavy)
- Moderation/labeler protocol (post-stability)

---

## What changed since the previous M2 roadmap

The previous M2 roadmap (pre-v0.7.x) listed many items as "scoped, no
code" that have now shipped. Notably:

- AutoHeal recruit-with-cryptographic-verification (was scoped) — ✅ shipped
- Atomic Blind Custody (was vision) — ✅ shipped as production protocol
- Witness Tombstones (didn't exist) — ✅ added based on simulation evidence
- Per-operator sybil bounding (was scoped) — ✅ shipped via fairshare cap
- P2P trust pipeline without HTTPS dep (was implicit) — ✅ shipped via two new channels
- Live telemetry surfacing trust state (was missing) — ✅ shipped via WS feed

The remaining items are the ones that genuinely require new
engineering work or external dependencies, not the ones blocked on
the trust pipeline that 0.8.x just delivered.
