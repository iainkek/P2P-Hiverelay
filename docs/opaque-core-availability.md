# Opaque Core Availability Service

`opaque-core-availability` is an opt-in Hive service for persistently seeding a
public Hypercore and proving that a relay can read a challenged local block. It
is namespace-agnostic: the relay receives a public core key and opaque blocks,
not an application schema.

The service is disabled unless the operator selects the
`opaque-core-availability` plugin. It exposes exactly three capabilities:

- `register`
- `status`
- `prove`

Clients use the existing encrypted service channel:

```js
await relay.callService('opaque-core-availability', 'register', request)
await relay.callService('opaque-core-availability', 'status', request)
await relay.callService('opaque-core-availability', 'prove', challenge)
```

This is not an HTTP API for application clients. The operator-only
`/seed-core` route remains separate and unchanged.

## Authentication and request limits

Every method requires the 32-byte authenticated Noise peer identity supplied
by the service transport as `context.remotePubkey`. Request fields cannot
override that identity.

Requests are JSON and bounded to 1024 bytes by default. Core keys and nonces
are exactly 32 bytes encoded as 64 lowercase hexadecimal characters. Version 1
is the only accepted protocol version.

Registration is signed under the domain
`hiverelay.opaque-core-availability.register.v1` over:

```text
version, coreKey, nonce, expiresAt, authenticated caller public key
```

The signature key must equal the authenticated Noise peer key. The relay checks
shape, version, expiry, signature, nonce replay, per-caller quota, global core
quota, request rate, and storage capacity before calling `Seeder.seedCore`.
Nonce caches and token-bucket maps are bounded and idle-evicted. An exact
duplicate registration is idempotent; reuse of its nonce for a different
request returns `REPLAYED_NONCE`.

## Register

Request:

```json
{
  "version": 1,
  "coreKey": "<64 hex>",
  "nonce": "<64 hex>",
  "expiresAt": 1900000030000,
  "callerPubkey": "<64 hex>",
  "signature": "<128 hex>"
}
```

Success:

```json
{
  "ok": true,
  "code": "REGISTERED",
  "coreKey": "<64 hex>",
  "observedLength": 12,
  "contiguousLength": 12,
  "fork": 0,
  "seeding": true,
  "idempotent": false
}
```

The Seeder is the only component allowed to open the validated core key. Its
atomic persisted key set restores registrations after restart. Service stop
releases live ranges, DHT joins, timers, and cores but does not unpin them.
Destructive unregistration is deliberately not part of this service.

## Status

Request:

```json
{ "version": 1, "coreKey": "<64 hex>" }
```

Success returns `AVAILABLE` with the public core key, fork, observed length,
contiguous local length, and seeding flag. It never returns block bytes, local
paths, peer lists, or an inventory of registered keys. Unknown, closed,
non-public, and unregistered cores all return:

```json
{ "ok": false, "code": "NOT_SEEDED" }
```

Status is advisory. It is not evidence that the relay can answer a fresh local
challenge.

## Prove

Challenge:

```json
{
  "version": 1,
  "coreKey": "<64 hex>",
  "index": 11,
  "nonce": "<64 hex>",
  "minLength": 12
}
```

Before proof work, the relay validates the authenticated caller and request,
resolves the key through the existing app registry or the registered Seeder
registry, checks minimum observed length, rejects nonce replay, and applies
per-caller and global proof budgets. It never calls `store.get` for challenge
input.

The challenged index must be present according to `core.has(index)`. The block
is then read with `core.get(index, { wait: false })`; the relay never downloads
or proxies a missing block to answer a proof. Missing-local, closed, non-public,
and unknown cases return the same `NOT_SEEDED` union.

The response includes the existing Hypercore content proof when the registered
core exposes the standard proof primitives. The outer signature is domain
separated by `hiverelay.opaque-core-availability.proof.v1` and binds:

- protocol version and authenticated Noise caller;
- relay public key and exact core key;
- fork, observed length, and contiguous local length;
- challenged index, fresh nonce, and requested minimum length;
- challenged block hash and the content-proof hash.

Clients verify the expected relay, caller when pinned, core, index, nonce,
minimum length, block hash, content proof, and signature. The response labels
itself `proof-of-retrievability` using `retrievability-proof-v1`.

This is evidence of fresh local retrievability at the challenged index. It is
not proof of unique replication, permanent retention, whole-core completeness,
or future availability. Clients must also retrieve the required range and use
multiple independently identified storage paths when their availability model
requires redundancy.

## Stable failure unions

The service returns `{ "ok": false, "code": "..." }`. The public codes are:

- authentication and signature: `UNAUTHORIZED`, `BAD_SIGNATURE`;
- shape/version: `BAD_REQUEST`, `UNSUPPORTED_VERSION`, `BAD_CORE_KEY`,
  `BAD_NONCE`, `BAD_INDEX`, `BAD_MIN_LENGTH`, `BAD_EXPIRY`;
- freshness: `EXPIRED`, `EXPIRY_TOO_FAR`, `REPLAYED_NONCE`;
- resource bounds: `RATE_LIMITED`, `CALLER_QUOTA`, `GLOBAL_QUOTA`, `CAPACITY`;
- privacy-minimal availability: `NOT_SEEDED`, `MIN_LENGTH_UNAVAILABLE`;
- relay lifecycle: `SERVICE_UNAVAILABLE`.

## Explicit non-responsibilities

This service does not:

- decode or validate application payloads;
- append to a client core;
- order records or choose membership;
- act as an application writer, indexer, or quorum voter;
- evaluate poker actions, cards, or hands;
- hold client secret material;
- decide settlement, balances, payments, or any other money outcome;
- promise permanent retention;
- add a public HTTP route for application registration.

Those boundaries are mechanically checked by
`test/unit/p2poker-boundary.test.js`.

