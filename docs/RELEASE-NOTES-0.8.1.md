# HiveRelay 0.8.1 — Custody Hardening

Released: 2026-05-05

A focused patch on top of v0.8.0 closing three integrity gaps in the
custody pipeline. No protocol breaks, no migration required. Pure
hardening.

If you're upgrading from v0.7.x, read the
[v0.8.0 release notes](./RELEASE-NOTES-0.8.0.md) first — those cover
the protocol-level changes. This document covers what changed between
v0.8.0 and v0.8.1.

---

## What changed

### 1. Witness tombstones now require a matching non-serving-proof

Before v0.8.1, a `custody-expiry-witness` entry was accepted as long
as the signature verified and the witness's pubkey was valid. That
left a forgery vector: a witness could fabricate observations of a
relay's non-serving state without any matching relay self-attestation.

**v0.8.1** tightens the validator. A witness tombstone now requires:

- An indexed custody intent for the `intentId`.
- `blindContentId` matches the intent.
- `timestamp` is after `intent.retainUntil` (witnesses can't act before
  expiry).
- All three observation flags (`catalogPresent`, `gatewayServing`,
  `activeSwarmObserved`) report `false` — a witness who saw the relay
  still serving cannot sign a non-serving tombstone.
- The `nonServingProofHash` field hashes to an actual indexed
  `custody-non-serving-proof` from the same relay.

**Effect:** witnesses now cryptographically anchor to a specific
relay self-attestation. A bad witness can't forge a tombstone without
also forging the relay's signed non-serving-proof — which would require
the relay's secret key.

### 2. Source retirement is now first-write-wins

Before v0.8.1, the registry accepted later-timestamped `source-retired`
entries as overrides. In theory this allowed a publisher to "un-retire"
their authority by signing a newer source-retired entry with different
content (or potentially replay a manipulated entry).

**v0.8.1** makes source retirement irreversible by indexing logic. The
first valid source-retired entry for an intent wins; subsequent entries
are dropped at index time.

**Effect:** logical authority retirement is irreversible by construction.
Once published, no later entry can roll it back.

### 3. Redacted catalog entries no longer expose `appKey`

Before v0.8.1, `catalogForBroadcast()` redacted human-readable
metadata for blind/private apps but still surfaced the raw `appKey`
(the underlying Hyperdrive lookup key). For private custody, this was
a metadata leak — the address key links a blind entry to its content
identity in any system that knows the publisher's other apps.

**v0.8.1** sets `appKey: null` for redacted entries and surfaces
`blindContentId` instead. Federation peers and the public catalog see
the blind ID (which by design hides content identity) rather than the
underlying lookup key.

**Effect:** the redacted catalog is genuinely redacted. The address
key never appears in public broadcasts for blind entries.

---

## Status surfaces extended

`summarizeCustodyStatus` now reports witness state. The custody status
endpoint and dashboard `/ws` feed surface:

- `expiryWitnessCount` — total witness entries indexed for an intent
- `validExpiryWitnessCount` — witness entries that pass full validation
  (matching non-serving-proof, post-expiry timestamp, all observation
  flags false)
- `expiryWitnessRelays` — sorted list of relays observed by valid
  witnesses

The previous `nonServingProofCount` and `nonServingRelays` fields are
unchanged.

---

## Migration

**No action required.**

- No protocol changes.
- No config changes.
- No client SDK changes.
- Existing tests and integrations continue to work.

The witness validation tightening is at the validator level — it
doesn't break callers, it just rejects malformed entries that
shouldn't have been accepted in v0.8.0 either.

The source-retired immutability is at indexing logic — the protocol
already documented retirement as final; this just makes the
implementation match the documentation.

The `appKey` redaction for blind entries fixes a metadata leak. Any
client treating `appKey` as authoritative on blind entries should
treat the absence (`null`) as expected behavior.

---

## Verified

- 19 unit tests pass across the affected files (custody-signing,
  registry-custody, app-registry).
- E2E integration test passes 19 assertions on a real Hyperswarm
  testnet — full custody pipeline including witness tombstone now
  exercises the new validation rules.
- Lint clean.
- Both simulation harnesses (`simulate-blind-atomic-custody.js` and
  `simulate-auto-heal-bridge.js`) pass all scenarios.

---

## Compatibility

- **Forward-compatible** with v0.8.0 peers. A v0.8.0 peer can still
  accept entries from a v0.8.1 peer.
- **Backward-compatible** with v0.8.0 callers. Existing API and SDK
  usage unchanged.
- **Not compatible** with v0.7.x peers for custody operations
  (v0.7.x didn't ship custody at all). v0.7.x peers can still
  participate in persistent-availability replication.

---

## Upgrade path

```bash
# If you've installed via npm
npm update -g p2p-hiverelay

# If you've installed via Docker
docker pull ghcr.io/bigdestiny2/p2p-hiverelay:v0.8.1

# Restart the service
systemctl restart hiverelay
```

The relay picks up the v0.8.1 codebase on restart. No state migration
needed; no config changes needed.
