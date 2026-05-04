# HiveRelay Atomic Handoff Design

## One-line Goal
Provide a verifiable "source handoff" protocol where a publisher can prove that at least _N_ relays accepted custody of encrypted content before the source key is retired.

## Important Reality Check
Cryptography can prove:
- who signed what,
- when a handoff happened,
- that relays committed to retain specific ciphertext chunks.

Cryptography cannot prove:
- that a remote machine physically deleted bytes from every medium.

So we target **atomic custody transfer**, not perfect deletion.

## Threat Model and Property

### We want
- Bounded race window between "source has key K" and "network has custody".
- Verifiable start/end checkpoints for handoff.
- Optional "remote lock" where source key is revoked/rotated only after quorum receipts.

### We do not claim
- Absolute erasure proofs.
- Trustless guarantees against a malicious relay that snapshots memory/disk.

## Protocol Sketch (Atomic Handoff v1)

### Actors
- `Publisher` (origin peer)
- `Relay_i` (candidate custody peers)
- `Registry` (existing distributed registry log)

### Phase 0: Encrypt and stage
1. Publisher derives `contentKey` and encrypts data into chunk set `C`.
2. Publisher computes `rootHash = Merkle(C)`.
3. Publisher creates `handoffIntent`:
   - `intentId`
   - `contentId` (drive key / dataset key)
   - `rootHash`
   - `requiredReplicas` (e.g. 3)
   - `expiry`
   - `publisherPubkey`
4. Publisher signs intent and publishes to registry as `handoff-intent`.

### Phase 1: Relay custody receipts
1. Each relay verifies intent signature and policy.
2. Relay replicates encrypted chunks.
3. Relay signs `custodyReceipt`:
   - `intentId`
   - `relayPubkey`
   - `rootHash`
   - `chunkCommitment` (Bloom/Merkle subset commitment)
   - `retainUntil` timestamp
4. Relay appends receipt to registry as `handoff-receipt`.

### Phase 2: Quorum lock
1. Publisher watches registry for valid receipts.
2. Once `>= requiredReplicas` unique relay receipts exist:
   - Publisher emits `handoff-commit` (signed checkpoint).
   - Publisher rotates/revokes source key material (local operation).
3. Optional: publisher emits `source-retired` attestation.

### Phase 3: Auditable retention
1. Relays must answer random challenge requests on chunk hashes.
2. Missing challenge responses mark relay as degraded/slashed in reputation.
3. If quorum falls below threshold before `retainUntil`, repair flow re-seeds.

## How This Maps to Current HiveRelay

### Reuse existing components
- Seeding registry logs and peer-log federation
- Signed envelopes and verification paths
- Replication health/repair monitor
- Accept/queue/reject policy controls

### New registry entry types
- `handoff-intent`
- `handoff-receipt`
- `handoff-commit`
- `source-retired` (optional)
- `custody-challenge` / `custody-proof` (v2)

### Required code areas
- `packages/core/core/registry/index.js`:
  - new indexed maps for handoff intents/receipts/commits
  - signature + timestamp checks per new entry type
- `packages/core/core/relay-node/index.js`:
  - handoff state machine
  - quorum evaluator
  - key-retire trigger hook
- Service/plugin layer:
  - `custody` plugin exposing APIs:
    - `custody.startHandoff`
    - `custody.getHandoffStatus`
    - `custody.commitHandoff`
    - `custody.challengeRelay`

## Decision Matrix

| Option | Security Value | Complexity | Time-to-Value | Notes |
|---|---|---:|---:|---|
| A. Signed receipts only | Medium | Low | Fast | Proves acceptance claims, not retention |
| B. Receipts + quorum commit | High | Medium | Medium | Best MVP for "remote lock window" |
| C. B + challenge-response audits | Very High | High | Slower | Adds ongoing retention assurance |
| D. TEEs/proof-of-deletion research | Experimental | Very High | Long | Not practical for near-term product |

Recommended path: **B now**, then **C**.

## Product Positioning
Call this capability:
- "Atomic Handoff"
- "Quorum Custody Lock"

Avoid claiming:
- "Provable deletion"
- "Perfect atomic privacy"

Use language:
- "Cryptographically verifiable custody transfer with bounded handoff window."

## Rollout Plan

### Milestone 1 (1-2 days)
- Add new entry schemas and validators.
- Add `custody.startHandoff` + receipt ingest.
- Add status endpoint returning quorum progress.

### Milestone 2 (2-3 days)
- Implement `handoff-commit` generation.
- Wire key-rotation callback once quorum reached.
- Add integration tests for replay, forged receipts, and quorum thresholds.

### Milestone 3 (2-3 days)
- Add challenge-response retention audits.
- Tie failures into relay reputation and auto-repair.
- Expose dashboard panel for handoff confidence.

