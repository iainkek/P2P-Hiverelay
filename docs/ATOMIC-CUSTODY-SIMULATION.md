# Atomic Blind Custody Simulation

## Purpose

This simulation explores how HiveRelay can make blind atomic custody stronger without turning every relay into a permanent storage node.

Run it with:

```bash
node scripts/simulate-blind-atomic-custody.js --iterations 5000
```

JSON output:

```bash
node scripts/simulate-blind-atomic-custody.js --iterations 5000 --json
```

Optimization sweep:

```bash
node scripts/simulate-blind-atomic-custody.js --iterations 3000 --sweep --limit 8
```

The simulation is intentionally local and dependency-light. It models relay operators, regions, malicious operators, relay reliability, source handoff, post-source availability, ciphertext reconstruction risk, expiry violations, and witness detection.

## Latest Run

Command:

```bash
node scripts/simulate-blind-atomic-custody.js --iterations 5000
```

Result:

| Scenario | Commit | Availability | Adversary Reconstructs Ciphertext | Active Serving After Expiry | Undetected Active Serving |
|---|---:|---:|---:|---:|---:|
| `mirror-3-score` | 99.96% | 99.90% | 36.35% | 27.53% | 27.53% |
| `mirror-5-diverse` | 99.98% | 99.98% | 51.49% | 41.33% | 41.33% |
| `shards-10of16-random` | 96.58% | 97.39% | 0.60% | 74.86% | 74.86% |
| `shards-10of16-diverse` | 99.56% | 99.64% | 0.02% | 82.56% | 82.56% |
| `shards-10of16-witness5` | 99.56% | 99.56% | 0.02% | 81.50% | 0.46% |
| `shards-10of16-witness3x3` | 99.30% | 99.50% | 0.08% | 82.90% | 0.02% |
| `shards-8of24-witness7` | 100.00% | 100.00% | 9.50% | 88.84% | 0.02% |

The exact percentages are simulation outputs, not field guarantees. The direction is the important signal.

## Breakthrough Candidate: Witness Tombstone Quorum

The best next primitive is not "add more custody replicas." It is:

> Add independent non-storage witnesses that challenge relays after expiry and sign tombstones over observed non-serving state.

This gives HiveRelay a third role in the atomic custody flow:

| Role | Stores Content? | Signs What? | Purpose |
|---|---:|---|---|
| Publisher | Yes, initially | custody intent, commit, source retirement | Starts and retires source authority |
| Custody relay | Yes, encrypted only | receipt, proof, non-serving proof | Holds temporary encrypted data |
| Expiry witness | No | tombstone witness | Confirms post-expiry non-serving state |

The simulation shows why this matters:

- Diverse shards reduce ciphertext reconstruction risk dramatically.
- More custody relays increase the chance that at least one relay keeps serving after expiry.
- Witnesses reduce undetected active serving from roughly `82%` to below `1%` in the default model.
- Witnesses do this without receiving content, plaintext, decrypt keys, or shards.

This is a real architectural step forward because it turns expiry from relay self-attestation into observed network state.

## Current Recommended Atomic Profile

The optimizer now applies a production bar:

| Constraint | Bar |
|---|---:|
| Commit rate | `>= 98.5%` |
| Availability after source stop | `>= 99.5%` |
| Adversary ciphertext reconstruction | `<= 0.5%` |
| Undetected active serving after expiry | `<= 0.5%` |

Latest 3,000-iteration sweep recommendation:

| Parameter | Recommended Value |
|---|---:|
| Custody shards | `16` |
| Reconstruction threshold | `10-of-16` |
| Receipt quorum | `13-of-16` |
| Expiry witnesses | `7` |
| Witness rounds | `1` default, `3x2` or `5x2` for high-risk data |
| Selection | operator/region diverse |

Observed in the sweep:

| Metric | Result |
|---|---:|
| Availability after source stop | `99.77%` |
| Adversary ciphertext reconstruction | `0.03%` |
| Undetected active serving | `0.07%` |

This is the current "amazing but still practical" target: enough shards for strong availability, high enough threshold to resist malicious operator clusters, and enough witnesses to make post-expiry serving hard to hide.

## Protocol Shape

### 1. Custody Handoff

The existing blind custody flow remains:

```text
custody-intent
  -> custody-receipt quorum
  -> custody-commit
  -> source-retired
  -> custody-proof
```

### 2. Expiry

At `retainUntil`, temporary custody relays remove the content from active serving state:

```text
seeded/custodied
  -> retainUntil reached
  -> unseed locally
  -> remove active catalog entry
  -> stop swarm/gateway serving
  -> custody-non-serving-proof
```

### 3. Witness Tombstone Wave

Independent witnesses perform post-expiry probes:

- request `custody-non-serving-proof`,
- confirm public gateway says not seeded when applicable,
- confirm redacted catalog no longer exposes active custody,
- optionally perform DHT/swarm negative probes for active serving,
- sign a witness tombstone.

Suggested future registry entry:

```json
{
  "type": "custody-expiry-witness",
  "version": 1,
  "timestamp": 1777902200000,
  "intentId": "64 hex",
  "blindContentId": "64 hex",
  "relayPubkey": "64 hex",
  "witnessPubkey": "64 hex",
  "challengeNonce": "64 hex",
  "nonServingProofHash": "64 hex",
  "catalogPresent": false,
  "gatewayServing": false,
  "activeSwarmObserved": false,
  "signature": "128 hex"
}
```

Client rule:

> Treat temporary custody as expired only after relay non-serving proof plus an `M-of-N` witness tombstone quorum.

Recommended default:

```text
custody: 10-of-16 encrypted shards
receipt quorum: 13-of-16
expiry: relay non-serving proof + 5-of-7 witness tombstones
high-risk expiry: 2 rotating rounds of 5 witnesses
```

This does not prove physical deletion. It proves a stronger and more decentralized version of non-serving state.

## Strategic Finding

The two-plane design should become three-role custody:

- Persistent availability plane for apps/services/drives that must stay online.
- Atomic blind custody plane for encrypted temporary data.
- Witness tombstone role for proving expiry behavior without storing content.

The third role is the breakthrough. It lets lightweight relays participate in the trust network even if they do not want to store content. That broadens operator participation while improving atomic custody credibility.

## Next Implementation Layer

Recommended build order:

1. Add `custody-expiry-witness` signing and verification helpers.
2. Add registry indexing and status summaries for witness tombstones.
3. Add observer support for witness fanout.
4. Add policy: `requiredExpiryWitnesses`.
5. Add reputation impact when witnesses catch continued serving after expiry.
6. Add dashboard metrics: custody quorum, non-serving proof count, witness tombstone count.

## Caveats

- Witness tombstones still do not prove disk erasure.
- Negative network observations can be fooled by selective serving.
- Witness selection must be operator/region diverse.
- Witnesses need rate limits to prevent expiry-probe floods.
- A high-value adversary can wait until witnesses finish and serve later; long-lived random audits are still useful for sensitive flows.
