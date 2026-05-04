# HiveRelay Blind Atomic Custody Network

## Product Thesis

HiveRelay should make P2P content not only available, but **provably handed off to blind peers**.

The feature should be:

> Cryptographically verifiable custody transfer for encrypted P2P content, with blind relay peers, quorum receipts, source-authority retirement, and ongoing storage challenges.

This is stronger and more honest than "relay pinning." Pinning says "a relay says it has it." Blind Atomic Custody says "a quorum signed that it accepted custody of this exact encrypted shard/root, the source signed a final authority checkpoint, and clients can verify the relay set still answers challenges without giving relays plaintext or decryption keys."

## Blind Peering Requirement

This feature must be designed as **blind peering first**.

That means:

- Relays never receive plaintext.
- Relays never receive the data encryption key.
- Relays should not need to understand file names, app semantics, user identity, or content meaning.
- Registry entries for private custody should expose commitments and policy, not human-readable catalog metadata.
- Proofs prove possession of ciphertext/shards, not ability to decrypt.
- Source retirement retires authority, not a physical secret from a remote disk.

Transparent custody can exist later as an explicit operator mode for public apps and public mirrors. It must not be the default for this feature.

## Terminology

The community message uses `K` as "the key at the source." In HiveRelay design we need to separate three different keys:

| Name | Meaning | Relay Sees It? |
|---|---|---:|
| `addressKey` | Public Hypercore/Hyperdrive/storage lookup key or content address | Usually yes |
| `dataKey` | Symmetric key that decrypts the payload | No |
| `authorityKey` | Signing key that controls future state/source authority | Public key yes, secret key no |
| `blindSalt` | Random value used to hide content identity in public registries | No, unless content is public |

The protocol should avoid naming the public lookup key `contentKey` in new code because that is easy to confuse with a decryption key. Existing API compatibility can keep `contentKey` as an alias, but the custody protocol should prefer `addressKey`.

## The Hard Truth

Cryptography can prove:

- A publisher signed a handoff intent.
- A relay signed a custody receipt for a specific encrypted content root or shard root.
- A quorum of relays accepted custody before a deadline.
- A source key signed a final checkpoint saying clients should stop treating that key as the live source of future state.
- A relay answered possession challenges for specific ciphertext blocks/chunks at specific times.

Cryptography cannot prove, on normal commodity hardware:

- A remote peer physically deleted bytes.
- A source machine no longer has a copied `dataKey` or `authorityKey`.
- A relay did not snapshot memory or disk before deletion.

So the solvable feature is **blind atomic custody transfer and logical source retirement**, not perfect proof of deletion.

The product language should avoid "provable deletion" unless HiveRelay later adds a TEE/HSM mode. The strong near-term claim is:

> After handoff, clients can cryptographically verify that the old source authority key is no longer authoritative for the encrypted content's live custody state.

That is a valuable primitive.

## What The Community Suggestion Is Really Pointing At

The message asks whether a peer can confirm, with cryptographic evidence, that key `K` is no longer at the source. If possible, that creates a remote lock mechanism: a known start state, a known end state, and only a bounded race window in between.

We can split that into two problems:

| Problem | Can We Solve It? | Best HiveRelay Primitive |
|---|---:|---|
| Prove source physically deleted `dataKey` | No, not on normal hardware | Only with optional TEE/HSM attestation |
| Prove source `authorityKey` is no longer accepted | Yes | Source-authority retirement checkpoint |
| Prove relays accepted exact ciphertext/shards | Yes | Signed blind custody receipts |
| Prove relays still have ciphertext over time | Partially | Random ciphertext challenge-response proofs |
| Reduce race window during handoff | Yes | Two-phase handoff with deadline and quorum |
| Keep blind peers private by default | Yes | Encryption, shard manifests, redacted registry metadata |

## Blind Custody Security Model

### Non-Atomic Today

Today a publisher can seed a drive, relays can replicate it, and the registry can record acceptances. But the lifecycle is loose:

1. Source publishes content.
2. Relay starts seeding.
3. Relay may or may not fully anchor blocks.
4. Registry acceptance does not itself mean verified custody.
5. Source can go offline at any point.

That is good for availability, but not enough for a "remote lock" primitive.

It is also not blind enough for this feature if the relay receives a normal unencrypted app/drive. Atomic custody must treat ordinary public seeding as a separate feature. Blind custody needs a content package that is already encrypted before any relay sees it.

### Required Privacy Invariants

A valid blind custody handoff must satisfy these invariants:

| Invariant | Requirement |
|---|---|
| No plaintext at relay | Relay stores ciphertext bytes or erasure-coded ciphertext shards only |
| No decrypt key at relay | `dataKey` is never sent to relay over API, P2P, registry, logs, or catalog |
| Redacted catalog | Private blind entries expose commitments/status, not names or file trees |
| Possession without decryption | Relay proofs use ciphertext hash/chunk challenges |
| Authority separation | `authorityKey` signs lifecycle checkpoints but does not decrypt data |
| Scoped disclosure | Recipients get decryption material out-of-band, through app policy, or threshold release |
| Expiring participation | Relays can be removed from active quorum without requiring proof of physical deletion |

### Blind Atomic Custody Model

Blind atomic custody introduces a state machine:

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

### Blind Content Identity

Every handoff is bound to immutable content evidence:

- `addressKey`: 32-byte drive/core/content lookup key, when public routing needs it.
- `blindContentId`: hash commitment used in public registry views when `addressKey` should not be exposed.
- `contentType`: `app`, `drive`, `dataset`, `media`, or `shard-set`.
- `ciphertextRoot`: Merkle root, Hyperdrive version/root, shard manifest root, or encrypted manifest root.
- `contentVersion`: drive version or monotonic epoch.
- `byteLength`: optional declared byte size.
- `chunkCount`: optional chunk count for challenge selection.
- `shardPolicy`: optional erasure coding policy such as `10-of-16`.

For Hyperdrive, the MVP should bind to:

- drive key,
- drive version,
- Hyperdrive checkout/root metadata available after `drive.update()`,
- relay-local anchored version.

For blind private data, the stronger target is a separate encrypted shard manifest:

```json
{
  "version": 1,
  "blindContentId": "64 hex",
  "ciphertextRoot": "64 hex",
  "shardPolicy": "10-of-16",
  "shards": [
    {
      "shardId": 0,
      "relayHint": "optional 64 hex",
      "root": "64 hex",
      "byteLength": 1048576,
      "chunkCount": 256
    }
  ]
}
```

The shard manifest itself can be public if it contains no plaintext metadata and no decrypt material. For higher privacy, publish only its hash and give the manifest to authorized clients through the application.

## Registry Entry Types

### `custody-intent`

Published by the source.

```json
{
  "type": "custody-intent",
  "version": 1,
  "timestamp": 1777900000000,
  "intentId": "64 hex",
  "custodyMode": "blind",
  "addressKey": "optional 64 hex",
  "blindContentId": "64 hex",
  "contentType": "shard-set",
  "ciphertextRoot": "64 hex",
  "contentVersion": 42,
  "publisherPubkey": "64 hex",
  "requiredReplicas": 3,
  "candidateRelays": ["64 hex"],
  "deadline": 1777900300000,
  "retainUntil": 1780492000000,
  "privacyTier": "blind-private",
  "shardPolicy": "10-of-16",
  "metadataVisibility": "redacted",
  "policyHash": "64 hex",
  "signature": "128 hex"
}
```

Signature payload:

```text
hiverelay-custody-intent-v1 ||
intentId ||
custodyMode ||
addressKey ||
blindContentId ||
ciphertextRoot ||
contentVersion ||
requiredReplicas ||
deadline ||
retainUntil ||
shardPolicy ||
policyHash
```

Validation rules:

- `custodyMode` defaults to `blind`.
- If `privacyTier` is not public, `metadataVisibility` must be `redacted`.
- `addressKey` is optional; `blindContentId` is required.
- `dataKey` must never appear in the entry.
- File names, app names, user names, and plaintext metadata must never appear in blind private entries.

### `custody-receipt`

Published by each relay after it has actually anchored the content.

```json
{
  "type": "custody-receipt",
  "version": 1,
  "timestamp": 1777900100000,
  "intentId": "64 hex",
  "custodyMode": "blind",
  "addressKey": "optional 64 hex",
  "blindContentId": "64 hex",
  "ciphertextRoot": "64 hex",
  "contentVersion": 42,
  "relayPubkey": "64 hex",
  "relayRegion": "us-west",
  "shardIds": [0, 3, 9],
  "anchored": true,
  "retainUntil": 1780492000000,
  "storageCommitment": "64 hex",
  "signature": "128 hex"
}
```

Receipt validation rules:

- `relayPubkey` must match the peer log transport identity.
- `blindContentId`, `ciphertextRoot`, and `contentVersion` must match the intent.
- `timestamp` must be before the intent deadline.
- `retainUntil` must be at least the intent's requested `retainUntil`.
- Relay must not issue multiple conflicting receipts for the same intent.
- For sharded custody, the relay signs only for the shard IDs it actually anchored.
- Receipt signatures must not include or imply possession of `dataKey`.

### `custody-commit`

Published by the source once quorum is reached.

```json
{
  "type": "custody-commit",
  "version": 1,
  "timestamp": 1777900200000,
  "intentId": "64 hex",
  "addressKey": "optional 64 hex",
  "blindContentId": "64 hex",
  "ciphertextRoot": "64 hex",
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
  "addressKey": "optional 64 hex",
  "blindContentId": "64 hex",
  "publisherPubkey": "64 hex",
  "retiredAtVersion": 42,
  "nextAuthority": "64 hex",
  "signature": "128 hex"
}
```

This does **not** prove the source deleted the key. It proves the source key itself signed a checkpoint that clients can enforce.

Client rule:

> If a valid `source-retired` exists for blind content `X`, clients must reject any future live-authority claim from the old source authority key after `retiredAtVersion`.

That is the useful "K is no longer a source" interpretation.

### `custody-proof`

Published by auditors or challengers after relays answer proof-of-storage challenges.

```json
{
  "type": "custody-proof",
  "version": 1,
  "timestamp": 1777901000000,
  "intentId": "64 hex",
  "blindContentId": "64 hex",
  "relayPubkey": "64 hex",
  "challengeNonce": "64 hex",
  "shardIds": [0, 3],
  "blockIndices": [1, 9, 20],
  "passed": true,
  "latencyMs": 420,
  "observerPubkey": "64 hex",
  "signature": "128 hex"
}
```

This can reuse the existing `ProofOfRelay` machinery, but the proof must be linked back to a custody intent and must challenge ciphertext blocks or shard blocks only.

## How The Handoff Runs

### Phase 1: Prepare

1. Publisher creates or chooses content.
2. Publisher encrypts locally with `dataKey`.
3. Publisher optionally erasure-codes ciphertext into shards.
4. Publisher computes `blindContentId`, `ciphertextRoot`, and shard commitments.
5. Publisher signs `custody-intent`.
6. Registry indexes intent and exposes quorum status.

### Phase 2: Anchor

1. Relays evaluate policy:
   - content type,
   - privacy tier,
   - max bytes,
   - retain-until,
   - operator accept mode,
   - allowlist/delegation rules.
2. Relays seed and anchor ciphertext or assigned shards through the existing `seedApp` and repair path.
3. Once anchored, each relay signs a `custody-receipt` for the encrypted material it actually holds.

Important: a relay should not sign receipt merely because it accepted a seed request. It signs only after the content is actually anchored locally.

Also important: a relay never gets `dataKey`. If the relay has to decrypt to verify or serve the handoff, the design has failed the blind-peering requirement.

### Phase 3: Commit

1. Publisher watches receipts.
2. Once valid receipts meet `requiredReplicas`, publisher signs `custody-commit`.
3. If the content has live authority, publisher signs `source-retired`.
4. Clients now treat the relay quorum or next authority as the live custody source.

### Phase 4: Audit

1. Observers challenge relays periodically for ciphertext/shard blocks.
2. Passing proofs increase custody confidence.
3. Failing proofs reduce reputation and can trigger repair recruitment.
4. If quorum falls below threshold, state becomes `DEGRADED`.

## Blind Peering Architecture

Blind peering is not a bolt-on mode. It is the feature.

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

### Two Blind Custody Modes

| Mode | What Relay Stores | Best For | Privacy Strength |
|---|---|---|---|
| Blind mirror | Full encrypted drive/core blocks | Ghost Drive, public-key encrypted backups, app data mirrors | Good |
| Blind shards | Erasure-coded encrypted shards | Sensitive private data, multi-relay custody, private data rooms | Strongest |

Blind mirror is easier and can reuse Hyperdrive replication quickly. Blind shards are the long-term privacy primitive because no single relay has the full encrypted object, and even a leaked `dataKey` may require shard quorum to reconstruct old content.

### Metadata Rules

For `privacyTier: blind-private`:

- `/catalog.json` must not show `name`, `description`, `author`, file tree, categories, or app ID.
- Public status may show `blindContentId`, `state`, `requiredReplicas`, `receiptCount`, and region counts.
- Exact relay list should be configurable; private deployments may hide relay pubkeys from public HTTP views.
- Management APIs can reveal richer details only to relay admin or authenticated owner.
- Search/discovery for private blind content should happen through capability tokens, not public catalog browsing.

### Key Handling

`dataKey` lifecycle:

1. Generated locally by the publisher/app.
2. Used to encrypt payload before relay contact.
3. Never placed in registry, catalog, logs, API request body, seed request, service route, or proof message.
4. Shared only with authorized recipients through the app's own encrypted channel or threshold key release.
5. Rotated by creating a new encrypted epoch, not by asking relays to mutate old ciphertext.

`authorityKey` lifecycle:

1. Signs the custody intent.
2. Signs the commit once relay quorum is reached.
3. Signs source retirement.
4. After retirement, clients reject future authority claims from it for that content/epoch.

This is where the remote lock idea becomes enforceable: clients stop accepting the old source authority, even though no one can prove the old machine physically erased all bytes.

## API Surface

### Management API

```http
POST /api/custody/intents
GET  /api/custody/intents/:intentId
POST /api/custody/intents/:intentId/commit
POST /api/custody/intents/:intentId/retire-source
GET  /api/custody/content/:blindContentId/status
POST /api/custody/challenge
```

Suggested auth:

| Endpoint | Access |
|---|---|
| create intent | authenticated-user or relay-admin depending mode |
| get status | redacted public for public/blind commitments, authenticated-user for private detail |
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
custody.redacted-catalog
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
| `custody.redacted-catalog` | public |

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
this._blindIndexes = new Map()
```

Add methods:

```js
publishCustodyIntent(intent)
recordCustodyReceipt(receipt)
recordCustodyCommit(commit)
recordSourceRetirement(retirement)
recordCustodyProof(proof)
getCustodyStatus(intentId)
getCustodyStatusForContent(blindContentId)
getRedactedCustodyCatalog(filter)
```

Extend `_normalizeIndexedEntry` to validate the new entry types with the same strictness as `seed-request` and `seed-accept`.

Blind validation must additionally reject:

- any entry with `dataKey`, `secretKey`, `plaintext`, or `metadata` fields,
- `privacyTier: blind-private` entries with public catalog metadata,
- receipt entries that claim unassigned shards,
- proof entries that target plaintext block identifiers instead of ciphertext/shard identifiers.

### Relay Node

File: `packages/core/core/relay-node/index.js`

Add a custody controller that listens for:

- `anchored` events from `AppLifecycle`,
- registry `custody-intent` entries,
- relay policy changes,
- proof-of-relay results.

The controller decides:

- should this relay accept the custody intent?
- has this relay anchored the exact requested ciphertext root/version or shard assignment?
- should this relay sign a receipt?
- should repair be triggered if quorum degrades?
- should this relay expose only redacted catalog information?

### App Lifecycle

File: `packages/core/core/relay-node/app-lifecycle.js`

The key hook already exists: `this.emit('anchored', { appKey, version })`.

Atomic custody should listen to that event and then compute/verify the requested `ciphertextRoot` before issuing receipt.

For blind shards, app lifecycle may need a parallel `seedShardSet()` path instead of assuming every custody object is a full Hyperdrive.

### Proof Of Relay

File: `packages/core/core/protocol/proof-of-relay.js`

Reuse the challenge-response structure but extend result metadata so challenge results can include:

- `intentId`,
- `blindContentId`,
- `ciphertextRoot`,
- `receiptId`,
- observer signature.

### Reputation

Proof failures should affect relay score only when:

- the relay had signed custody receipt,
- retain window has not expired,
- challenge target is derived from the committed ciphertext root or shard root,
- challenge was valid and within rate limits.

## Test Plan

### Unit Tests

- Reject invalid `custody-intent` signatures.
- Reject impossible timestamps/deadlines.
- Reject receipt from relay pubkey that does not match peer log identity.
- Reject receipt after deadline.
- Reject receipt with wrong ciphertext root/version.
- Reject duplicate conflicting receipt.
- Compute quorum only from unique relays.
- Do not commit before quorum.
- Reject source retirement without publisher signature.
- Reject post-retirement source authority claims in verifier helper.
- Reject any blind custody entry containing `dataKey`, plaintext metadata, or file names.
- Verify redacted catalog output does not expose private blind metadata.
- Verify proofs challenge ciphertext/shard blocks only.

### Integration Tests

- Start publisher + 3 blind relays.
- Encrypt data locally and publish intent requiring 2 replicas.
- Anchor ciphertext/shards on 2 relays.
- Verify quorum reached.
- Commit handoff.
- Stop publisher.
- Verify content remains available from relays.
- Run ciphertext proof challenge against relays.
- Simulate one relay failure and verify state becomes degraded.
- Trigger repair and verify state recovers.
- Verify relays never receive decrypt material during the flow.

### Abuse Tests

- Forged relay receipt from another peer log.
- Replay old receipt into new intent.
- Receipt for same blind content ID but wrong version.
- Intent flood rate limiting.
- Huge candidate relay list.
- Private-tier intent against public relay policy.
- Commit with non-quorum relay list.
- Registry entry that includes forbidden plaintext metadata.
- Public catalog scrape of blind-private entries.
- Relay claiming full-object custody when it only holds one shard.

## MVP Decision

Build this in three layers.

### Layer 1: Blind Custody Receipts

This is the MVP.

Ship:

- blind registry entry types,
- validation that forbids decrypt keys and plaintext metadata,
- relay receipt issuance after encrypted anchor,
- redacted status endpoint,
- tests.

Claim:

> Blind relays can issue verifiable custody receipts after anchoring encrypted content.

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

- scheduled ciphertext/shard challenges,
- proof publication,
- degradation state,
- repair recruitment,
- reputation impact.

Claim:

> Blind relay custody is continuously audited after handoff.

## Why This Can Be A Key HiveRelay Feature

Most relay systems stop at availability. HiveRelay can own a sharper primitive:

| Product | Primitive |
|---|---|
| IPFS pinning | "Someone says they pinned it" |
| Cloud storage | "Provider stores it under contract" |
| Basic P2P relay | "Peer stays online" |
| HiveRelay Blind Atomic Custody | "A signed blind quorum accepted encrypted custody and clients can verify the handoff" |

That gives HiveRelay a value prop for:

- Ghost Drive style always-online files.
- Private data rooms.
- App updates and package mirrors.
- Compliance-oriented custody logs.
- Marketplace/incentive settlement.
- Disaster recovery for Pear apps.
- Multi-region content guarantees.
- Privacy-preserving dead drops and escrowed data handoffs.

## Recommended Product Name

Use:

- **Atomic Custody**
- **Custody Quorum**
- **Source Retirement**
- **Blind Relay Mode**
- **Blind Atomic Custody**

Avoid:

- "Provable deletion"
- "Trustless deletion"
- "Perfect remote lock"

Best homepage sentence:

> HiveRelay Blind Atomic Custody lets P2P apps hand encrypted content to a verified blind relay quorum, retire the original source as live authority, and keep auditing availability after the source goes offline.
