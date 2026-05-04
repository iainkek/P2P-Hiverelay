# HiveRelay Atomic Custody Network

## Product Thesis

HiveRelay should make P2P content not only available, but **provably handed off**.

The feature should be:

> Cryptographically verifiable custody transfer for P2P content, with quorum receipts, source-authority retirement, and ongoing storage challenges.

This is stronger and more honest than "relay pinning." Pinning says "a relay says it has it." Atomic custody says "a quorum signed that it accepted custody of this exact content root, the source signed a final authority checkpoint, and clients can verify the relay set still answers challenges."

## The Hard Truth

Cryptography can prove:

- A publisher signed a handoff intent.
- A relay signed a custody receipt for a specific content root.
- A quorum of relays accepted custody before a deadline.
- A source key signed a final checkpoint saying clients should stop treating that key as the live source of future state.
- A relay answered possession challenges for specific blocks/chunks at specific times.

Cryptography cannot prove, on normal commodity hardware:

- A remote peer physically deleted bytes.
- A source machine no longer has a copied private key.
- A relay did not snapshot memory or disk before deletion.

So the solvable feature is **atomic custody transfer and logical source retirement**, not perfect proof of deletion.

The product language should avoid "provable deletion" unless HiveRelay later adds a TEE/HSM mode. The strong near-term claim is:

> After handoff, clients can cryptographically verify that the old source key is no longer authoritative for the content's live custody state.

That is a valuable primitive.

## What The Community Suggestion Is Really Pointing At

The message asks whether a peer can confirm, with cryptographic evidence, that key `K` is no longer at the source. If possible, that creates a remote lock mechanism: a known start state, a known end state, and only a bounded race window in between.

We can split that into two problems:

| Problem | Can We Solve It? | Best HiveRelay Primitive |
|---|---:|---|
| Prove source physically deleted `K` | No, not on normal hardware | Only with optional TEE/HSM attestation |
| Prove source key is no longer accepted as authority | Yes | Source-authority retirement checkpoint |
| Prove relays accepted custody of exact ciphertext | Yes | Signed custody receipts |
| Prove relays still have data over time | Partially | Random challenge-response proofs |
| Reduce race window during handoff | Yes | Two-phase handoff with deadline and quorum |
| Make blind peers safe for privacy | Yes, if ciphertext-only | Erasure-coded encrypted shards and no plaintext keys |

## Core Security Model

### Non-Atomic Today

Today a publisher can seed a drive, relays can replicate it, and the registry can record acceptances. But the lifecycle is loose:

1. Source publishes content.
2. Relay starts seeding.
3. Relay may or may not fully anchor blocks.
4. Registry acceptance does not itself mean verified custody.
5. Source can go offline at any point.

That is good for availability, but not enough for a "remote lock" primitive.

### Atomic Custody Model

Atomic custody introduces a state machine:

```text
NONE
  -> INTENT_PUBLISHED
  -> RECEIPTS_COLLECTING
  -> QUORUM_REACHED
  -> COMMITTED
  -> SOURCE_RETIRED
  -> AUDITED
```

If quorum fails before deadline, the state becomes:

```text
ABORTED
```

No handoff is considered complete unless the registry contains a valid quorum and a signed commit.

## Protocol Overview

### Actors

- `Publisher`: original source or app/device initiating handoff.
- `Relay`: custody peer that stores encrypted data and signs receipts.
- `Observer`: client, verifier, auditor, or another relay.
- `Registry`: existing HiveRelay distributed registry log.

### Content Identity

Every handoff is bound to immutable content evidence:

- `contentKey`: 32-byte drive/core/content key.
- `contentType`: `app`, `drive`, `dataset`, `media`, or `shard-set`.
- `contentRoot`: Merkle root, Hyperdrive version/root, or manifest root.
- `contentVersion`: drive version or monotonic epoch.
- `byteLength`: optional declared byte size.
- `chunkCount`: optional chunk count for challenge selection.

For Hyperdrive, the MVP should bind to:

- drive key,
- drive version,
- Hyperdrive checkout/root metadata available after `drive.update()`,
- relay-local anchored version.

Later, for stronger storage proofs, HiveRelay should create a separate shard manifest with chunk roots.

## Registry Entry Types

### `custody-intent`

Published by the source.

```json
{
  "type": "custody-intent",
  "version": 1,
  "timestamp": 1777900000000,
  "intentId": "64 hex",
  "contentKey": "64 hex",
  "contentType": "drive",
  "contentRoot": "64 hex",
  "contentVersion": 42,
  "publisherPubkey": "64 hex",
  "requiredReplicas": 3,
  "candidateRelays": ["64 hex"],
  "deadline": 1777900300000,
  "retainUntil": 1780492000000,
  "privacyTier": "public",
  "policyHash": "64 hex",
  "signature": "128 hex"
}
```

Signature payload:

```text
hiverelay-custody-intent-v1 ||
intentId ||
contentKey ||
contentRoot ||
contentVersion ||
requiredReplicas ||
deadline ||
retainUntil ||
policyHash
```

### `custody-receipt`

Published by each relay after it has actually anchored the content.

```json
{
  "type": "custody-receipt",
  "version": 1,
  "timestamp": 1777900100000,
  "intentId": "64 hex",
  "contentKey": "64 hex",
  "contentRoot": "64 hex",
  "contentVersion": 42,
  "relayPubkey": "64 hex",
  "relayRegion": "us-west",
  "anchored": true,
  "retainUntil": 1780492000000,
  "storageCommitment": "64 hex",
  "signature": "128 hex"
}
```

Receipt validation rules:

- `relayPubkey` must match the peer log transport identity.
- `contentRoot` and `contentVersion` must match the intent.
- `timestamp` must be before the intent deadline.
- `retainUntil` must be at least the intent's requested `retainUntil`.
- Relay must not issue multiple conflicting receipts for the same intent.

### `custody-commit`

Published by the source once quorum is reached.

```json
{
  "type": "custody-commit",
  "version": 1,
  "timestamp": 1777900200000,
  "intentId": "64 hex",
  "contentKey": "64 hex",
  "contentRoot": "64 hex",
  "contentVersion": 42,
  "publisherPubkey": "64 hex",
  "relayQuorum": ["64 hex", "64 hex", "64 hex"],
  "receiptRoot": "64 hex",
  "nextAuthority": "64 hex",
  "signature": "128 hex"
}
```

`nextAuthority` can be:

- a relay quorum key,
- a threshold custody key,
- a new app signing key,
- or `null` for immutable content where the commit simply retires live source duties.

### `source-retired`

Published by the source key as the final authority checkpoint.

```json
{
  "type": "source-retired",
  "version": 1,
  "timestamp": 1777900210000,
  "intentId": "64 hex",
  "contentKey": "64 hex",
  "publisherPubkey": "64 hex",
  "retiredAtVersion": 42,
  "nextAuthority": "64 hex",
  "signature": "128 hex"
}
```

This does **not** prove the source deleted the key. It proves the source key itself signed a checkpoint that clients can enforce.

Client rule:

> If a valid `source-retired` exists for content key `X`, clients must reject any future live-authority claim from the old source key after `retiredAtVersion`.

That is the useful "K is no longer a source" interpretation.

### `custody-proof`

Published by auditors or challengers after relays answer proof-of-storage challenges.

```json
{
  "type": "custody-proof",
  "version": 1,
  "timestamp": 1777901000000,
  "intentId": "64 hex",
  "contentKey": "64 hex",
  "relayPubkey": "64 hex",
  "challengeNonce": "64 hex",
  "blockIndices": [1, 9, 20],
  "passed": true,
  "latencyMs": 420,
  "observerPubkey": "64 hex",
  "signature": "128 hex"
}
```

This can reuse the existing `ProofOfRelay` machinery, but the proof must be linked back to a custody intent.

## How The Handoff Runs

### Phase 1: Prepare

1. Publisher creates or chooses content.
2. Publisher computes content evidence.
3. Publisher signs `custody-intent`.
4. Registry indexes intent and exposes quorum status.

### Phase 2: Anchor

1. Relays evaluate policy:
   - content type,
   - privacy tier,
   - max bytes,
   - retain-until,
   - operator accept mode,
   - allowlist/delegation rules.
2. Relays seed and anchor content through the existing `seedApp` and repair path.
3. Once anchored, each relay signs a `custody-receipt`.

Important: a relay should not sign receipt merely because it accepted a seed request. It signs only after the content is actually anchored locally.

### Phase 3: Commit

1. Publisher watches receipts.
2. Once valid receipts meet `requiredReplicas`, publisher signs `custody-commit`.
3. If the content has live authority, publisher signs `source-retired`.
4. Clients now treat the relay quorum or next authority as the live source.

### Phase 4: Audit

1. Observers challenge relays periodically.
2. Passing proofs increase custody confidence.
3. Failing proofs reduce reputation and can trigger repair recruitment.
4. If quorum falls below threshold, state becomes `DEGRADED`.

## Blind Peer Privacy Mode

The strongest privacy form is not "relay promises deletion." It is:

1. Relays store only encrypted shards.
2. No single relay has enough shards to reconstruct content.
3. Decryption key is held by publisher, recipient, or threshold policy.
4. Relays can prove possession of ciphertext chunks.
5. Relays can be removed from the active quorum by authority checkpoint.

For high-risk private data, use:

- Reed-Solomon erasure coding: e.g. 10-of-16 shards.
- Per-shard encryption.
- Relay diversity constraints.
- Threshold key release for authorized recipients.
- No plaintext processing by relay.

This makes "blind peers that hold encrypted data, pass it on, and self-remove" realistic. The self-remove part is enforced by protocol reputation and authority membership, not by magic deletion proof.

## API Surface

### Management API

```http
POST /api/custody/intents
GET  /api/custody/intents/:intentId
POST /api/custody/intents/:intentId/commit
POST /api/custody/intents/:intentId/retire-source
GET  /api/custody/content/:contentKey/status
POST /api/custody/challenge
```

Suggested auth:

| Endpoint | Access |
|---|---|
| create intent | authenticated-user or relay-admin depending mode |
| get status | public for public content, authenticated-user for private |
| commit | publisher signature required |
| retire source | publisher signature required |
| challenge | authenticated-user with rate limits |

### Service Routes

```text
custody.start-handoff
custody.get-status
custody.commit
custody.retire-source
custody.issue-receipt
custody.challenge
custody.verify-proof
```

Access policy:

| Route | Access |
|---|---|
| `custody.get-status` | public/authenticated based on privacy tier |
| `custody.start-handoff` | authenticated-user |
| `custody.commit` | authenticated-user + publisher signature |
| `custody.retire-source` | authenticated-user + publisher signature |
| `custody.issue-receipt` | relay-admin/local-only |
| `custody.challenge` | authenticated-user |
| `custody.verify-proof` | public |

## Codebase Integration

### Registry

File: `packages/core/core/registry/index.js`

Add maps:

```js
this._custodyIntents = new Map()
this._custodyReceipts = new Map()
this._custodyCommits = new Map()
this._sourceRetirements = new Map()
this._custodyProofs = new Map()
```

Add methods:

```js
publishCustodyIntent(intent)
recordCustodyReceipt(receipt)
recordCustodyCommit(commit)
recordSourceRetirement(retirement)
recordCustodyProof(proof)
getCustodyStatus(intentId)
getCustodyStatusForContent(contentKey)
```

Extend `_normalizeIndexedEntry` to validate the new entry types with the same strictness as `seed-request` and `seed-accept`.

### Relay Node

File: `packages/core/core/relay-node/index.js`

Add a custody controller that listens for:

- `anchored` events from `AppLifecycle`,
- registry `custody-intent` entries,
- relay policy changes,
- proof-of-relay results.

The controller decides:

- should this relay accept the custody intent?
- has this relay anchored the exact requested content root/version?
- should this relay sign a receipt?
- should repair be triggered if quorum degrades?

### App Lifecycle

File: `packages/core/core/relay-node/app-lifecycle.js`

The key hook already exists: `this.emit('anchored', { appKey, version })`.

Atomic custody should listen to that event and then compute/verify the requested `contentRoot` before issuing receipt.

### Proof Of Relay

File: `packages/core/core/protocol/proof-of-relay.js`

Reuse the challenge-response structure but extend result metadata so challenge results can include:

- `intentId`,
- `contentKey`,
- `contentRoot`,
- `receiptId`,
- observer signature.

### Reputation

Proof failures should affect relay score only when:

- the relay had signed custody receipt,
- retain window has not expired,
- challenge target is derived from the committed content root,
- challenge was valid and within rate limits.

## Test Plan

### Unit Tests

- Reject invalid `custody-intent` signatures.
- Reject impossible timestamps/deadlines.
- Reject receipt from relay pubkey that does not match peer log identity.
- Reject receipt after deadline.
- Reject receipt with wrong content root/version.
- Reject duplicate conflicting receipt.
- Compute quorum only from unique relays.
- Do not commit before quorum.
- Reject source retirement without publisher signature.
- Reject post-retirement source authority claims in verifier helper.

### Integration Tests

- Start publisher + 3 relays.
- Publish intent requiring 2 replicas.
- Anchor on 2 relays.
- Verify quorum reached.
- Commit handoff.
- Stop publisher.
- Verify content remains available from relays.
- Run proof challenge against relays.
- Simulate one relay failure and verify state becomes degraded.
- Trigger repair and verify state recovers.

### Abuse Tests

- Forged relay receipt from another peer log.
- Replay old receipt into new intent.
- Receipt for same content key but wrong version.
- Intent flood rate limiting.
- Huge candidate relay list.
- Private-tier intent against public relay policy.
- Commit with non-quorum relay list.

## MVP Decision

Build this in three layers.

### Layer 1: Custody Receipts

This is the MVP.

Ship:

- registry entry types,
- validation,
- relay receipt issuance after anchor,
- status endpoint,
- tests.

Claim:

> Relays can issue verifiable custody receipts after anchoring content.

### Layer 2: Quorum Commit And Source Retirement

This is the real product unlock.

Ship:

- quorum evaluator,
- commit endpoint,
- source-retired checkpoint,
- verifier/client helper that enforces retirement.

Claim:

> Clients can verify that content has moved from source availability to relay-quorum custody.

### Layer 3: Challenge Audits

This makes the network credible over time.

Ship:

- scheduled challenges,
- proof publication,
- degradation state,
- repair recruitment,
- reputation impact.

Claim:

> Relay custody is continuously audited after handoff.

## Why This Can Be A Key HiveRelay Feature

Most relay systems stop at availability. HiveRelay can own a sharper primitive:

| Product | Primitive |
|---|---|
| IPFS pinning | "Someone says they pinned it" |
| Cloud storage | "Provider stores it under contract" |
| Basic P2P relay | "Peer stays online" |
| HiveRelay Atomic Custody | "A signed quorum accepted custody and clients can verify the handoff" |

That gives HiveRelay a value prop for:

- Ghost Drive style always-online files.
- Private data rooms.
- App updates and package mirrors.
- Compliance-oriented custody logs.
- Marketplace/incentive settlement.
- Disaster recovery for Pear apps.
- Multi-region content guarantees.

## Recommended Product Name

Use:

- **Atomic Custody**
- **Custody Quorum**
- **Source Retirement**
- **Blind Relay Mode**

Avoid:

- "Provable deletion"
- "Trustless deletion"
- "Perfect remote lock"

Best homepage sentence:

> HiveRelay Atomic Custody lets P2P apps hand content to a verified relay quorum, retire the original source as live authority, and keep auditing availability after the source goes offline.

