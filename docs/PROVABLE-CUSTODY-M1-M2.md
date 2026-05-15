# Provable Custody — M1 (shipped on this branch) + M2 (scaffolded)

**Branch:** `feat/provable-custody`
**Companion drop-pear branch:** `feat/provable-custody`
**Author:** Iain (with cross-repo plan from `drop-pear/docs/PROVABLE-CUSTODY-ROADMAP.md`)
**Status:** M1 complete with passing tests; M2 surface scaffolded, crypto TODO.

This document is the operator's-eye-view of the changes this branch makes
to HiveRelay, and what's still needed before M2 ships. The cross-repo
roadmap rationale (why these primitives at all, how they relate to DMC's
"K-no-longer-at-source" question) lives in
`drop-pear/docs/PROVABLE-CUSTODY-ROADMAP.md`.

---

## M1 — Binding Witnesses (SHIPPED)

### What it adds

Two new signed custody-entry types in `custody-signing.js`:

| Type | Signer | Body |
|---|---|---|
| `source-retired-witness` | publisher | `intentId, kPub` |
| `custody-claim-witness` | recipient | `intentId, bindingSignature` |

Plus three new helpers:

- `canonicalClaimBindingPayload({ intentId, recipientPubkey, timestamp })`
  — returns the exact bytes both sender and recipient must sign over.
- `verifyClaimBinding(claimWitness, kPubHex)` — verifies the inner
  binding signature against the publisher's committed kPub.
- `findCustodyConflict(sourceRetiredWitness, claimWitnesses)` — returns
  `{ left, right }` if two distinct recipients both produced valid
  binding signatures, or null.

### How it works

The drop's symmetric key `K` is mapped to an Ed25519 keypair via:

```
seed = blake2b(K || "drop-binding-v1")
(kPriv, kPub) = ed25519_seed_keypair(seed)
```

The publisher publishes `source-retired-witness` containing `kPub`
(signed under their publisherPubkey). The recipient, after Shamir-
recombining K, derives the SAME keypair locally and signs a canonical
claim-payload `(intentId || recipientPubkey || timestamp)` with kPriv,
embedding the signature in `custody-claim-witness`.

Only a party holding K can produce a signature that verifies under the
publisher-committed kPub. Two distinct recipients both submitting valid
claim-witnesses for the same intent = algebraic proof of double-issuance.

### What it catches

- Sender accidentally publishing a drop URL twice and a second recipient claims through the protocol.
- Sender's machine compromised → attacker replays the claim flow with a different recipient identity.
- Sender deliberately serves K to a second party who performs the formal claim.

### What it doesn't catch

- Sender extracts K + plaintext after their own claim and emails the
  plaintext out-of-band. Unfixable by any cryptographic protocol — at some
  point the sender holds the bytes.
- Sender extracts K + the sealed shares from the drive, gives both to a
  second party who decrypts directly without ever submitting a claim
  through the protocol. **This is the case M2 closes.**

### Files changed (M1)

```
packages/core/core/custody-signing.js
  + new message types: source-retired-witness, custody-claim-witness
  + constructors: createSourceRetiredWitness, createCustodyClaimWitness
  + verification: canonicalClaimBindingPayload, verifyClaimBinding, findCustodyConflict
  + validation transitions: enforce predecessor source-retired-witness, verify inner binding

packages/core/core/registry/index.js
  + two new in-memory indexes: _sourceRetiredWitnesses, _custodyClaimWitnesses
  + appendable methods: publishSourceRetiredWitness, recordCustodyClaimWitness
  + query methods: getSourceRetiredWitness, getCustodyClaimWitnesses, getCustodyConflict
  + getCustodyStatus extended with binding-witness fields

packages/core/core/protocol/publish-channel.js
  + SUBMIT_KINDS extended with 'source-retired-witness', 'custody-claim-witness'
  + dispatcher routes to onSubmitSourceRetiredWitness / onSubmitCustodyClaimWitness

packages/core/core/relay-node/index.js
  + PublishProtocol now wires onSubmitSourceRetiredWitness + onSubmitCustodyClaimWitness
    to the registry methods
  + custody-entry-appended event bubble map adds the two new types

test/unit/custody-binding-witness.test.js (new, 10 tests, all pass)
  - signature verification round-trips
  - tampering detection
  - K-derivation determinism
  - findCustodyConflict positive + negative cases
```

### Test status (M1)

```
$ npx brittle test/unit/custody-signing.test.js test/unit/custody-binding-witness.test.js

# tests = 20/20 pass
# asserts = 70/70 pass
```

---

## M2 — Threshold-Encrypted Shares (SCAFFOLD)

### What's scaffolded

New files with explicit `M2 TODO` markers:

- `packages/core/core/protocol/dkg-channel.js` — Protomux channel `hiverelay-dkg-v1` with message-type enum and a `DkgProtocol` class. All cryptographic methods throw `not implemented`.
- `packages/core/core/dkg-state.js` — `DkgState` class for persisting the relay's DKG share. All methods stub with TODOs.

### What's required to finish M2

| Component | Effort | Notes |
|---|---|---|
| Pedersen DKG primitive | 2 weeks | Pure-JS port of a vetted impl, or a sodium-native binding over Curve25519/Ristretto point arithmetic. |
| Threshold ElGamal | 1.5 weeks | Encryption + partial-decrypt + NIZK proofs of correctness. |
| Ceremony state machine | 1 week | Round 1/2/3 + complaint round + abort handling. |
| Re-keying scheduler | 0.5 week | Periodic + membership-triggered ceremonies. |
| DKG state persistence | 0.5 week | Durable keystore for share material. |
| Authority-destruction at retire | 1 week | Bridge from M1: publisher's authority key becomes provably-destroyed at source-retired. This is the conceptual crux. |
| Drop-side integration | 2 weeks | Sender encrypts to pool jointPubkey, recipient drives threshold-decrypt. |
| End-to-end test | 1 week | Multi-node ceremony + claim test against testnet. |
| **Total** | **~10 weeks** | One engineer, focused. |

### Open questions

1. **Pool scope:** per-app or per-network? Per-app = better isolation, more ceremonies. Per-network = simpler. Tentative recommendation: per-app, with a default fallback.

2. **Authorization for partial-decrypt:** Who can request a partial? The publisher signing `(intentId, recipientPubkey)` works, but only if their authority key is destroyed at retirement. Otherwise they can authorize a second claim post-retirement, defeating M2's purpose.

3. **Library choice:** port Coinbase's `kryptology` (Go → JS), use `@noble/curves` for primitives, or hand-roll over sodium-native? `@noble/curves` looks like the right primitive layer; the threshold protocol on top is custom regardless.

4. **Mid-ceremony robustness:** what happens when a relay drops mid-keygen? Need clean abort + retry semantics that don't leak partial shares.

---

## Backwards compatibility

M1 is **fully additive**. Existing v3 escrow drops (no binding witnesses)
continue to work exactly as before. Relays that don't speak the new
message types simply ignore them on the publish channel. Registries that
don't index them return null from `getCustodyConflict()`.

M2 will require a coordinated rollout — drops created against pool epoch
E_n must be claimable as long as ≥ t relays still hold E_n shares. The
re-keying protocol handles this by retaining old pool shares until all
intents bound to that epoch have expired.

---

## Cross-repo coordination

The drop-pear side of M1 lives on `feat/provable-custody` in that repo.
The drop branch pins `p2p-hiverelay` as a `file:` dependency on this
checkout (so both branches must be local for development). To ship M1
to production:

1. Merge this branch on HiveRelay; bump to `v0.9.0`.
2. Publish to npm.
3. Drop's branch swaps the file: dep back to `^0.9.0` and merges.
4. New drops created against v0.9.x relays automatically include
   `source-retired-witness` + `custody-claim-witness` artifacts. Old
   drops (pre-v0.9 envelope) keep working without M1 guarantees.

---

## What this demonstrates for DMC

The artifact: with M1 deployed, every completed Drop produces a tiny
public record in the registry. If anyone ever serves K twice through
the protocol, `findCustodyConflict()` returns a 3-tuple
(source-retired-witness, claim-witness-A, claim-witness-B) that anyone
can verify without holding K themselves. The math is short, the
primitives are vetted, and the demo is concrete: deliberately cheat
one test drop and watch the conflict pair appear in the registry.

That's the "cryptographic evidence that K is no longer at source" he
asked about, modulo the unfixable plaintext-exfil case M2 closes.
