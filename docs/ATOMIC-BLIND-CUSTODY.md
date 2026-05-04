# Atomic Blind Custody

**A protocol for cryptographically verifiable custody transfer of encrypted P2P content, with blind relay peers, quorum receipts, source-authority retirement, and independent expiry attestation.**

Version 1.0 — HiveRelay 0.8.0
Last revised: 2026-05-04

---

## Abstract

Existing P2P relay infrastructure offers availability without provable custody. A relay that says "I have your content" cannot be distinguished, by an observer, from one that says it but doesn't. Existing privacy-preserving relays solve confidentiality through encryption but leave the custody question unanswered: did a quorum actually accept the encrypted bytes? Did the original source give up authority over future state? Did the relay stop serving when its retention window ended?

Atomic Blind Custody addresses these questions with a six-message signed-state-machine protocol layered on an append-only registry log. Relays never receive plaintext or decryption keys. A publisher signs a custody intent declaring the encrypted ciphertext root and replication target. Each anchoring relay signs a custody receipt over the exact ciphertext root it accepted. When a quorum is reached, the publisher signs a commit and a source-retirement checkpoint, transferring authority. Independent observers sign possession proofs during the retention window. After expiry, relays sign non-serving proofs, and independent non-storage witnesses sign tombstones over the relay's observed state.

Simulation across 5,000 trials shows the protocol holds 99%+ commit and availability under realistic adversarial assumptions, while the witness tombstone primitive drops undetected post-expiry serving from approximately 82% to less than 1% with no availability cost. The full protocol is implemented in HiveRelay 0.8.0 and runs end-to-end against a real Hyperswarm testnet.

---

## 1. Introduction

P2P infrastructure has converged on availability through replication: publish content, relays seed it, peers consume it. This is sufficient for public, append-only data. It is not sufficient for any of these classes of application:

- **Time-bounded data transfer.** A sender wants to hand off encrypted content with a clear retention window after which the relay must stop serving.
- **Auditable handoff.** Two parties want a cryptographic record of who took custody when, for forensic or contractual purposes, without trusting any single relay.
- **Privacy-preserving archival.** Content must be replicated for durability without exposing plaintext or metadata to the storage layer.
- **Source-authority retirement.** A publisher needs to retire their signing authority over future state in a way clients can verify.

The existing tools — Hyperswarm DHT discovery, Hypercore append-only logs, Hyperdrive content-addressed storage — provide the substrate, but no protocol assembles them into the primitive these applications need.

Atomic Blind Custody is that protocol. It treats each handoff as a state machine with six signed transitions, requires explicit privacy invariants enforced at the validator level, and introduces a third role (the non-storage witness) that closes the post-expiry serving leak that storage replication alone cannot address.

This document specifies the protocol, analyzes its security and privacy properties, presents simulation evidence, and describes the reference implementation in HiveRelay.

---

## 2. Goals and Non-Goals

### 2.1 Goals

The protocol provides:

1. **Custody quorum.** A publisher can prove that ≥N independent relays each cryptographically accepted custody of a specific encrypted ciphertext root before a deadline.
2. **Privacy preservation.** Relays never receive plaintext, decryption keys, file names, or human-readable catalog metadata for blind-mode content.
3. **Authority retirement.** A publisher can retire their authority key for a content epoch, after which clients refuse to accept further state changes signed by that key.
4. **Possession verification.** Observers (or the publisher) can challenge any custody relay for ciphertext-block possession at arbitrary times during the retention window.
5. **Expiry attestation.** When a retention window ends, custody relays sign non-serving proofs, and independent witnesses sign tombstones over the relay's observed state — making continued unauthorized serving detectable without giving witnesses storage responsibility.
6. **Compositional auditing.** Every custody-relevant event is a signed entry in a replicated append-only log. An auditor can reconstruct the full lifecycle of any handoff from the log alone.

### 2.2 Non-Goals

The protocol explicitly does not provide:

1. **Provable physical deletion.** On commodity hardware, cryptography cannot prove a remote peer erased bytes from disk or did not snapshot memory before deletion. The protocol delivers logical source retirement and observed non-serving state, not forensic erasure.
2. **Confidentiality against the publisher.** The publisher knows the plaintext and the data key. The protocol prevents leakage to relays and intermediaries; it does not protect against a malicious publisher.
3. **Sub-millisecond handoff latency.** Custody quorum requires at least one round-trip for receipt collection plus a commit. The protocol is not a CDN.
4. **Universal availability.** The protocol assumes at least one honest custody relay reaches anchoring. If the entire quorum colludes or fails, no protocol-level recovery is possible.

### 2.3 The hard truth

Cryptography on standard hardware can prove:

- A publisher signed a handoff intent.
- A relay signed a custody receipt for a specific encrypted root.
- A quorum of relays accepted custody before a deadline.
- A source key signed a final lifecycle checkpoint.
- A relay answered possession challenges for specific ciphertext blocks at specific times.

Cryptography cannot prove:

- A remote peer physically deleted bytes.
- A source machine no longer holds a copy of `dataKey` or `authorityKey`.
- A relay did not retain a snapshot before deletion.

The protocol is honest about this boundary. The product language uses "logical source retirement" and "observed non-serving state," not "provable deletion." TEE/HSM attestation for forensic erasure is enumerated as an optional future extension, not a current claim.

---

## 3. Threat Model

### 3.1 Adversaries

The protocol assumes the following adversary classes:

- **Curious relay.** A relay operator who would read or analyze plaintext content if it could.
- **Lying relay.** A relay that claims to have anchored content it has not actually replicated.
- **Continuing-to-serve relay.** A relay that promises to expire content at `retainUntil` but secretly continues serving past that window.
- **Sybil cluster.** An adversary controlling N pubkeys but a small number of distinct operators or regions, attempting to fill quorum slots.
- **Authority-impersonator.** An attacker with access to the publisher's authority key after retirement, attempting to forge new state.
- **Replay adversary.** An attacker re-broadcasting old signed entries to confuse the registry.

### 3.2 Trust assumptions

The protocol relies on:

1. **At least `requiredReplicas` honest relays exist** in the network and are reachable before the intent's deadline.
2. **Witnesses and custody relays do not collude.** A custody relay that bribes its witnesses can hide continued serving. The protocol's witness diversity policy mitigates this by requiring operator/region-diverse witness sets.
3. **The publisher's authority key is securely managed** until retirement. Source-retirement is cryptographic; it is meaningful only if the authority key was protected before retirement.
4. **The Hyperswarm DHT and Hypercore log replication are operational.** The protocol assumes the substrate's safety properties, including signature verification and append-only ordering.

### 3.3 Out-of-scope threats

- Physical compromise of relay hardware.
- Side-channel attacks on signing operations.
- Long-range attacks on Ed25519 (assumed cryptographically sound).
- Network-level censorship preventing relay-to-relay communication.

---

## 4. Protocol Specification

### 4.1 Actors

The protocol has four actor roles:

| Role | Function | Stores content? | Signs |
|---|---|---|---|
| **Publisher** | Initiates handoff, retires authority | Yes initially | intent, commit, source-retired |
| **Custody Relay** | Stores encrypted ciphertext, attests custody | Yes (encrypted only) | receipt, proof, non-serving-proof |
| **Observer** | Issues possession challenges, signs proofs of relay performance | No | proof |
| **Witness** | Probes relay state at expiry, attests to observed non-serving state | No | expiry-witness tombstone |

A single network participant may hold multiple roles simultaneously. A relay can act as custody peer for some intents and as witness for others.

### 4.2 Key model

The protocol distinguishes four cryptographic identifiers:

| Key | Function | Visible to relays? |
|---|---|---|
| `addressKey` | Public lookup key (Hyperdrive key, content address) | Usually yes |
| `dataKey` | Symmetric key that decrypts the payload | **Never** |
| `authorityKey` | Signing key controlling future lifecycle state | Public yes, secret never |
| `blindSalt` | Optional randomness hiding content identity in public registries | No (unless content is public) |

Existing implementations may use the term `contentKey` as a backward-compatible alias for `addressKey`; new code uses `addressKey` to avoid conflation with the data key.

### 4.3 Privacy invariants

A valid blind custody handoff must satisfy seven invariants. The reference implementation enforces these at the validator level — the signing function rejects any entry violating them before producing a signature.

| Invariant | Enforcement |
|---|---|
| No plaintext at relay | Relay stores ciphertext bytes or erasure-coded ciphertext shards only |
| No decrypt key at relay | `dataKey` never appears in any custody message; the validator hard-blocks ten field names: `dataKey, decryptionKey, plaintext, fileName, filename, path, name, description, author, categories` |
| Redacted catalog | Private blind entries expose only commitments and status, not human-readable metadata |
| Possession without decryption | Proofs use ciphertext-hash and chunk challenges; relays prove possession without decrypting |
| Authority separation | `authorityKey` signs lifecycle checkpoints and does not function as a data key |
| Scoped disclosure | Recipients receive decryption material out-of-band through application policy or threshold release |
| Expiring participation | Relays can be removed from active quorum at `retainUntil` without requiring proof of physical deletion |

### 4.4 State machine

A custody handoff progresses through six states:

```
NONE
  → INTENT_PUBLISHED       (publisher signs custody-intent)
  → RECEIPTS_COLLECTING    (relays anchor, sign custody-receipt)
  → QUORUM_REACHED         (≥ requiredReplicas valid receipts)
  → COMMITTED              (publisher signs custody-commit)
  → SOURCE_RETIRED         (publisher signs source-retired)
  → AUDITED                (observer/witness entries accumulate)
```

Failure path:

```
NONE → INTENT_PUBLISHED → RECEIPTS_COLLECTING → ABORTED
```

A handoff is considered complete only when the registry contains:
- A valid signed intent.
- ≥ `requiredReplicas` valid signed receipts whose timestamps precede the intent's `deadline`.
- A signed commit whose `receiptRoot` matches the deterministic hash over the receipt set.
- A signed source-retired entry from the same publisher.

Out-of-order arrival is supported. A commit indexed before all its receipts is held in a pending state and becomes effective once receipts arrive.

### 4.5 Message specification

All messages are signed Ed25519 envelopes with a v1 schema. Each message type has a defined signer field; the validator enforces this binding.

#### 4.5.1 `custody-intent`

Published by the source. Declares the handoff parameters.

```json
{
  "type": "custody-intent",
  "version": 1,
  "timestamp": 1777900000000,
  "intentId": "hex(32)",
  "custodyMode": "blind",
  "addressKey": "hex(32) | optional",
  "blindContentId": "hex(32)",
  "contentType": "shard-set | drive | dataset | media | app",
  "ciphertextRoot": "hex(32)",
  "contentVersion": "uint64",
  "publisherPubkey": "hex(32)",
  "requiredReplicas": "uint",
  "candidateRelays": ["hex(32)..."],
  "deadline": "ms epoch",
  "retainUntil": "ms epoch",
  "privacyTier": "blind-private | p2p-only | public",
  "shardPolicy": "all | k-of-n",
  "metadataVisibility": "redacted",
  "policyHash": "hex(32)",
  "signature": "hex(64)"
}
```

Signature payload:

```
hiverelay-custody-intent-v1 ||
intentId || custodyMode || addressKey || blindContentId ||
ciphertextRoot || contentVersion || requiredReplicas ||
deadline || retainUntil || shardPolicy || policyHash
```

#### 4.5.2 `custody-receipt`

Signed by each anchoring relay.

```json
{
  "type": "custody-receipt",
  "intentId": "...",
  "ciphertextRoot": "...",
  "relayPubkey": "...",
  "relayRegion": "...",
  "shardIds": [0, 3, 9],
  "anchored": true,
  "retainUntil": "...",
  "storageCommitment": "hex(32)",
  "signature": "..."
}
```

Validation: `relayPubkey` must match the transport peer identity. `blindContentId`, `ciphertextRoot`, and `contentVersion` must match the intent. `timestamp` must precede `intent.deadline`. `retainUntil` must be ≥ `intent.retainUntil`. A relay must not issue conflicting receipts for the same intent.

#### 4.5.3 `custody-commit`

Signed by the publisher when quorum is reached.

```json
{
  "type": "custody-commit",
  "intentId": "...",
  "publisherPubkey": "...",
  "relayQuorum": ["hex(32)..."],
  "receiptRoot": "hex(32)",
  "nextAuthority": "hex(32) | null",
  "signature": "..."
}
```

`receiptRoot` is the deterministic hash over the relay quorum's receipts. The validator recomputes this from the indexed receipts and rejects mismatches.

#### 4.5.4 `source-retired`

Signed by the publisher to relinquish authority over future state.

```json
{
  "type": "source-retired",
  "intentId": "...",
  "publisherPubkey": "...",
  "retiredAtVersion": "uint64",
  "nextAuthority": "hex(32) | null",
  "signature": "..."
}
```

After source retirement, clients refuse to accept further state-change signatures from `publisherPubkey` for this content epoch. If `nextAuthority` is set, that pubkey is the new accepted signer.

#### 4.5.5 `custody-proof`

Signed by an observer attesting that a relay passed a possession challenge.

```json
{
  "type": "custody-proof",
  "intentId": "...",
  "blindContentId": "...",
  "relayPubkey": "...",
  "challengeNonce": "hex(32)",
  "shardIds": [...],
  "blockIndices": [...],
  "passed": true,
  "latencyMs": "...",
  "observerPubkey": "...",
  "signature": "..."
}
```

Observers may be the publisher, dedicated audit nodes, or other relays.

#### 4.5.6 `custody-non-serving-proof`

Signed by a custody relay attesting it has stopped serving content after `retainUntil`.

```json
{
  "type": "custody-non-serving-proof",
  "intentId": "...",
  "relayPubkey": "...",
  "challengeNonce": "hex(32)",
  "retainUntil": "...",
  "notServing": true,
  "notServingReason": "expired-unseeded",
  "catalogPresent": false,
  "activeSwarmServing": false,
  "limitationHash": "hex(32)",
  "signature": "..."
}
```

The `limitationHash` is a fixed value referencing a published limitation note, e.g., "this proof attests active relay state at challenge time, not forensic disk erasure." Including it in the signed payload makes the limitation impossible to omit silently.

#### 4.5.7 `custody-expiry-witness`

Signed by an independent non-storage witness over the relay's observed state at expiry.

```json
{
  "type": "custody-expiry-witness",
  "intentId": "...",
  "blindContentId": "...",
  "relayPubkey": "...",
  "witnessPubkey": "...",
  "challengeNonce": "hex(32)",
  "nonServingProofHash": "hex(32)",
  "catalogPresent": false,
  "gatewayServing": false,
  "activeSwarmObserved": false,
  "signature": "..."
}
```

The witness probes the relay's catalog, gateway, and swarm and signs over what it observed. The `nonServingProofHash` references the relay's own non-serving-proof, anchoring the witness attestation to a specific relay self-report.

### 4.6 Quorum policy

A handoff requires:

- `intent.requiredReplicas` valid receipts.
- All receipts before `intent.deadline`.
- `commit.receiptRoot == computeReceiptRoot(receipts)`.
- `commit.relayQuorum == sorted(distinct relayPubkey from receipts)`.

The `computeReceiptRoot` function is order-invariant: it hashes the sorted list of receipt signatures, so the root depends only on the set of receipts, not their arrival order. This lets observers verify quorum without consensus on receipt ordering.

### 4.7 Witness Tombstone Quorum

For high-integrity expiry, applications may require an `M-of-N` witness tombstone quorum in addition to the relay's own non-serving-proof. Recommended defaults from the simulation analysis (Section 6):

- Witness count: 7
- Required quorum: 5-of-7
- Witness selection: operator-diverse and region-diverse
- High-risk content: 2 rotating rounds of 5 witnesses each

The witness role does not store content, so adding witnesses is operationally inexpensive. The simulation shows witness quorum is the highest-leverage primitive for closing the post-expiry serving leak.

---

## 5. Security Analysis

### 5.1 Custody quorum integrity

**Property:** An attacker cannot forge a commit without `requiredReplicas` valid receipts.

**Analysis:** The commit contains a `receiptRoot` that the validator recomputes from the indexed receipts. Forging a commit requires either:
- Forging receipts (requires the corresponding relay's secret keys), or
- Predicting the receipt root without the receipts (requires a hash collision).

Both reduce to the underlying signature scheme and hash function security.

**Limit:** If `requiredReplicas` exceeds the network's honest relay count, the attacker can use sybils. The application's threat model determines what `requiredReplicas` and the operator-diversity requirements should be.

### 5.2 Source authority retirement

**Property:** After a source-retired entry, clients will not accept new state-change signatures from the retired authority key.

**Analysis:** Clients verify the source-retired entry's signature, then reject future entries signed by `publisherPubkey` for that content epoch. If `nextAuthority` is set, only that key is accepted.

**Limit:** This is logical retirement, not key destruction. If the retired authority key is later compromised, the attacker cannot retroactively author state — but they could also have forged retirement itself, so this protection only meaningful when the retirement is observed by clients before the key is compromised.

### 5.3 Privacy

**Property:** Relays cannot decrypt content or learn human-readable metadata for blind-mode entries.

**Analysis:**
- The validator hard-blocks the ten plaintext field names. Custody entries violating this rule cannot be signed.
- All ciphertext is encrypted by the publisher before any relay sees it.
- The signature payload references commitments (`ciphertextRoot`, `blindContentId`, `policyHash`), not plaintext.
- Decryption material flows out-of-band, by application policy, never through the registry log or relay catalog.

**Limit:** A malicious publisher could include plaintext in `ciphertextRoot` (e.g., by failing to encrypt). The protocol cannot detect this — the relay sees opaque bytes regardless. This is consistent with the protocol's threat model: confidentiality against relays, not against the publisher.

### 5.4 Sybil resistance

**Property:** A sybil cluster controlling N pubkeys but a single operator/region cannot dominate quorum.

**Analysis:** The reference implementation's AutoHeal scheduler enforces an operator fairshare cap of `ceil(target / minOperators)` replicas per operator. Witness selection policies require operator-diverse witnesses. Both push sybil control to require operator/region diversity, which is a real-world constraint (multiple cloud accounts, multiple regions, different jurisdictions).

**Limit:** If sybils acquire genuine operator/region diversity, the cap does not stop them. The protocol's defense is operator declaration honesty, which depends on operator economic incentives and reputation.

### 5.5 Continued-serving detection

**Property:** A relay that violates `retainUntil` by continuing to serve content after expiry can be detected with high probability.

**Analysis:** The relay's own non-serving-proof claims compliance. Independent witnesses probe the relay's catalog, gateway, and swarm and sign tombstones over observed state. If the relay continues to serve, witnesses observe it and decline to sign tombstones — or, if witnesses collude with the relay, the application's witness diversity policy makes the collusion expensive.

**Quantitative result (Section 6):** A 5-of-7 witness quorum reduces undetected continued serving from approximately 82% (storage-only model) to less than 1%.

**Limit:** A high-value adversary may wait until witnesses finish probing and resume serving. Long-lived random audits are recommended for sensitive flows.

### 5.6 Replay resistance

**Property:** A signed entry cannot be replayed for a different intent, content, or time window.

**Analysis:** Each entry's signature payload includes the `intentId` (a hash binding to the intent's content + version + timestamp + publisher), the relevant content commitments, and the entry timestamp. Replaying an entry into a different intent fails signature verification. The validator also enforces a `FUTURE_SKEW_TOLERANCE_MS` of 10 minutes and a `MAX_ENTRY_AGE_MS` of 180 days; entries outside this window are rejected.

---

## 6. Simulation Evidence

The protocol is accompanied by a Monte Carlo simulation (`scripts/simulate-blind-atomic-custody.js`) that models a 72-relay, 16-operator, 7-region network across multiple custody scenarios. Each scenario runs 5,000 iterations with malicious-operator injection, churn, and post-expiry observation.

### 6.1 Scenarios

| Scenario | Configuration |
|---|---|
| `mirror-3-score` | 3 full encrypted mirrors, score-biased relay selection |
| `mirror-5-diverse` | 5 full encrypted mirrors, operator/region-diverse selection |
| `shards-10of16-random` | 16 ciphertext shards, 10 needed to reconstruct, random selection |
| `shards-10of16-diverse` | 16 shards, 10-of-16 reconstruction, diverse selection |
| `shards-10of16-witness5` | Diverse shards + 5 expiry witnesses |
| `shards-10of16-witness3x3` | Diverse shards + 2 rounds of 3 witnesses |
| `shards-8of24-witness7` | 24 shards, 8-of-24 reconstruction, 7 witnesses |

### 6.2 Results

| Scenario | Commit | Availability | Adv. Reconstructs | Active After Expiry | Undetected |
|---|---:|---:|---:|---:|---:|
| `mirror-3-score` | 99.96% | 99.90% | 36.35% | 27.53% | 27.53% |
| `mirror-5-diverse` | 99.98% | 99.98% | 51.49% | 41.33% | 41.33% |
| `shards-10of16-random` | 96.58% | 97.39% | 0.60% | 74.86% | 74.86% |
| `shards-10of16-diverse` | 99.56% | 99.64% | 0.02% | 82.56% | 82.56% |
| `shards-10of16-witness5` | 99.56% | 99.56% | 0.02% | 81.50% | **0.46%** |
| `shards-10of16-witness3x3` | 99.30% | 99.50% | 0.08% | 82.90% | **0.02%** |
| `shards-8of24-witness7` | 100.00% | 100.00% | 9.50% | 88.84% | **0.02%** |

(All numbers are simulation outputs, not field guarantees. The directional signal is the contribution.)

### 6.3 Key findings

**Diverse shards reduce ciphertext-reconstruction risk by orders of magnitude.** Random selection in shard mode produces 0.60% reconstruction risk (one adversary in 167 attempts succeeds); diverse selection reduces this to 0.02%.

**Witnesses dominate the post-expiry detection problem.** Storage-only configurations leave continued serving undetected at 27%–82% rates. Adding 5 witnesses drops this to 0.46%; rotating two rounds of 3 drops it to 0.02%. Witnesses add no availability cost.

**The witness role broadens operator participation.** Witnesses do not store content. Operators who do not want storage responsibility can participate in the trust network as witnesses, increasing the protocol's diversity floor without scaling storage requirements.

### 6.4 Recommended atomic profile

The simulation's optimizer suggests the following defaults for a production atomic-custody profile:

| Parameter | Recommended |
|---|---|
| Custody shards | 16 |
| Reconstruction threshold | 10-of-16 |
| Receipt quorum | 13-of-16 |
| Expiry witnesses | 7 |
| Witness rounds | 1 (default), 3×2 or 5×2 for high-risk |
| Selection | operator/region-diverse |

Observed metrics under this profile: availability 99.77%, adversary reconstruction 0.03%, undetected continued serving 0.07%.

---

## 7. Implementation

The protocol is implemented in HiveRelay 0.8.0:

- **Cryptographic primitive:** `packages/core/core/custody-signing.js` (582 lines). Ed25519 signing for all seven message types, validator-level enforcement of the privacy invariants, schema enforcement.
- **Registry integration:** `packages/core/core/registry/index.js`. Custody messages are appended to the relay's local Hypercore log and replicated network-wide. Indexes maintain in-memory views per intent. Out-of-order receipts are supported.
- **REST API:** Seven custody endpoints under `/api/custody/*`. Auth-required for all write operations.
- **P2P transport:** Two Protomux channels.
  - `hiverelay-anchor` for proof requests over the Hyperswarm connection (no HTTPS dependency).
  - `hiverelay-custody` for real-time push of custody entries between connected relays. Hypercore log replication remains the durable backstop.
- **Auto-emit receipts:** Relays automatically issue signed receipts when anchoring a `blind: true` app with a `custodyIntentId`. No manual receipt step required from the operator.
- **Expiry monitor:** Background scheduler unseeds temporary-custody apps after `retainUntil` and emits `custody-expired` events.
- **Witness role:** New message type `custody-expiry-witness`, registry indexing, dedicated REST endpoint, channel allowlist entry.
- **Client SDK:** Seven custody methods on `HiveRelayClient` (publish/record/get).
- **Observability:** WebSocket dashboard feed broadcasts aggregate custody snapshots (intents, quorums met, commits, proofs, witness tombstones) and pushes individual custody events on receipt.

A 19-assertion end-to-end integration test (`test/integration/blind-custody-e2e.test.js`) exercises the full pipeline against three real RelayNode instances on a Hyperswarm testnet.

### 7.1 Default configuration

```js
custody: {
  enabled: true,
  defaultMode: 'blind',
  allowTransparent: false,
  requireEncryptedPayload: true,
  metadataVisibility: 'redacted',
  redactedCatalog: true,
  proofTarget: 'ciphertext',
  defaultRetainMs: 30 * 24 * 60 * 60 * 1000  // 30 days
}
```

Operators may opt into transparent custody for public mirror use cases by setting `allowTransparent: true` and `defaultMode: 'transparent'`. The default deployment is blind.

---

## 8. Open Questions

The following are deliberately deferred for future work:

1. **TEE/HSM-attested deletion mode.** A relay equipped with attested execution could provide cryptographic evidence of disk erasure. The current protocol does not specify the attestation format; this is a candidate v0.9.x extension.
2. **Witness reputation.** Witnesses caught colluding with custody relays should accumulate negative reputation. The current protocol does not specify the reputation model; this is application-policy-dependent.
3. **Cross-network witness federation.** A witness on one HiveRelay deployment attesting to a relay on another deployment is a useful primitive for cross-organizational audits. The protocol supports it cryptographically; deployment patterns are not yet codified.
4. **Threshold encryption integration.** The protocol assumes the publisher manages `dataKey` distribution. Integrating threshold release schemes (e.g., timelock encryption) would let custody serve as a verifiable timelock. This is application-layer composition; the protocol does not yet specify primitives.
5. **Bandwidth-proof integration.** The existing `proof-of-relay` channel attests to bandwidth served. Composing it with custody would give "I have it AND I'm serving it at this rate" attestations; the integration is straightforward but not yet wired.

---

## 9. Comparison to Adjacent Work

| Approach | Custody | Privacy | Expiry attestation |
|---|---|---|---|
| IPFS pinning services | Self-report | None (plaintext) | None |
| Filecoin storage proofs | Cryptographic, periodic | Optional encryption | None |
| Storj erasure coding | Self-report + node-audit | Encrypted | None |
| Sia storage contracts | Periodic Merkle proofs | Encrypted | Contract-level |
| **Atomic Blind Custody** | **Quorum receipts + ongoing proofs** | **Validator-enforced blind** | **Witness tombstones** |

The closest analogues are Sia's storage contracts and Filecoin's PoSt, which provide ongoing storage attestation. Neither addresses post-expiry detection, the privacy-invariant enforcement at validator level, or the three-role architecture (publisher / custody / witness).

---

## 10. References

1. Holepunch — *Hyperswarm DHT*. <https://docs.holepunch.to/building-blocks/hyperswarm>
2. Holepunch — *Hypercore append-only log*. <https://docs.holepunch.to/building-blocks/hypercore>
3. HiveRelay — *Atomic Network Design (full design doc)*. `docs/atomic-network-design.md`
4. HiveRelay — *Atomic Custody Simulation*. `docs/ATOMIC-CUSTODY-SIMULATION.md`
5. HiveRelay — *Project Focus and Bloat Audit*. `docs/PROJECT-FOCUS-AND-BLOAT-AUDIT.md`
6. RFC 8032 — *Edwards-Curve Digital Signature Algorithm (EdDSA)*.
7. Filecoin — *Proof of Spacetime*. <https://docs.filecoin.io/storage-providers/get-started/architecture>

---

## Appendix A: Field Reference

| Field | Type | Constraints |
|---|---|---|
| `intentId` | hex(32) | Deterministic hash over (blindContentId, ciphertextRoot, contentVersion, publisherPubkey, timestamp) |
| `blindContentId` | hex(32) | Application-defined hash; hides content identity in public registries |
| `ciphertextRoot` | hex(32) | Merkle root of encrypted bytes or shard manifest |
| `contentVersion` | uint64 | Monotonic per-content epoch |
| `publisherPubkey` | hex(32) | Ed25519 public key |
| `requiredReplicas` | uint | Quorum threshold |
| `deadline` | ms epoch | Receipt cutoff |
| `retainUntil` | ms epoch | Expiry boundary |
| `shardIds` | uint[] | Subset of shards held |
| `policyHash` | hex(32) | Hash over (custodyMode, metadataVisibility, shardPolicy) |
| `nextAuthority` | hex(32) \| null | Optional successor authority key |

## Appendix B: Forbidden plaintext fields

The validator rejects any custody entry containing any of the following fields:

```
dataKey, decryptionKey, plaintext, fileName, filename,
path, name, description, author, categories
```

This is the privacy floor as code, not as policy. Adding a forbidden field to a custody entry causes the signing function to throw before producing a signature.

## Appendix C: Wire encoding

All custody Protomux messages use a 4-byte length-prefixed JSON encoding:

```
[uint32 BE length][JSON UTF-8 body]
```

Maximum message size is 256 KB for `hiverelay-custody` and 64 KB for `hiverelay-anchor`. Future versions may switch to a compact encoding for performance.

---

*HiveRelay 0.8.0 ships the reference implementation. The protocol is independent of any specific implementation; alternative implementations are welcome.*
