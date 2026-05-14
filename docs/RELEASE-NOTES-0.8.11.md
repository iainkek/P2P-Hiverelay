# HiveRelay 0.8.11 — Loud `maxStorage` Failures

Released: 2026-05-14

Fixes the silent-partial-pin bug surfaced by the pearbrowser-desktop
maintainers — see `docs/FEEDBACK-PEARBROWSER-PIN-CAP-FAILURE.md` for
the full case study.

If you're upgrading from v0.8.10, no migration required. The behavior
change is publisher-facing: too-small `maxStorage` caps now fail loudly
at pin time instead of failing silently at end-user-runtime.

---

## The bug we're fixing

A publisher seeds a Hyperdrive with `maxStorage: 256 * 1024 * 1024`
(256 MB). Over many releases, the drive grows to 365 MB. The relay
ACKs the seed request, replicates the metadata core fully, then
stalls mid-blob when it hits the 256 MB allocation. The publisher's
SDK callback says everything succeeded. End users on a fresh machine
hang forever on `pear run pear://<key>` because ~30% of blob blocks
are missing and no peer has them.

Every Pear app project that grows past its declared `maxStorage`
hits this trap silently. Indistinguishable from a network bug from
both sides.

## Three fixes, all publisher-facing

### Fix #1 — Relay-side size check (loud abort)

After the first metadata sync in `eagerReplicate()`, the relay now
computes `drive.db.core.byteLength + drive.blobs.core.byteLength`
and compares against the publisher's declared `maxStorage`. If
the drive exceeds the cap:

- Emit a `seed-aborted` event with full diagnostics:
  ```js
  {
    appKey, reason: 'maxStorage-too-small',
    driveBytes, metaBytes, blobBytes, cap,
    recommendedCap,  // = driveBytes * 1.25, rounded up
    hint: 'drive is 382911336 bytes; publisher should re-seed with maxStorage ≥ 478639170'
  }
  ```
- Call `unseedApp(appKey)` to clean up — no partial state retained.
- Return from `eagerReplicate` without anchoring.

The relay's `RelayNode.on('seed-aborted', …)` and the client SDK's
`HiveRelayClient.on('seed-aborted', …)` both surface this event so
pin scripts can fail their release pipeline at pin time.

### Fix #4 — Client SDK size-default and warning

`client.seed(driveKey, opts)` now:

1. **If `opts.maxStorage` is missing** and the drive is locally
   accessible, computes `(metaBytes + blobBytes) × 4` as the default.
   Falls back to `1 GB` (up from the prior `500 MB`) when the drive
   isn't local.
2. **If `opts.maxStorage` is explicitly set** but smaller than the
   drive's current size, emits a `seed-cap-warning` event AND prints
   a `console.warn` with the recommended cap. The seed still goes
   through (the publisher might know what they're doing), but the
   warning is loud.

The `_observedDriveSize(keyHex)` helper looks the drive up in the
client's local corestore — best-effort + synchronous, never blocks on
network I/O.

### Fix #5 — `docs/PUBLISHING.md`

A new publisher-facing guide covering:
- The `maxStorage` trap in detail
- How to size the cap correctly (drive size × 4 headroom)
- A `verify-pin.js` template for fresh-corestore round-trip blob
  fetching after every release
- The three publisher commitment fields (`revocable`,
  `unseedFreezeMs`, `durability`) and when to use them
- A complete pin-script template that uses the new events
- A failure-mode reference table

---

## Deferred to v0.8.12

The pearbrowser feedback also asked for two larger additions, which
need their own protocol design discussion and ship as a separate
release:

- **`seed-progress` and `seed-stalled` push events** — relay tells
  the publisher periodic download progress over the existing seed
  protomux channel, with explicit stall detection. New message
  types on the seed channel.
- **`client.queryContent(driveKey)` RPC** — asks N relays "do you
  currently have all of this drive's blob blocks", returns
  `{ relayPubkey, version, blockCoverage }`. New REST endpoint
  + client SDK method.

Both are tracked as v0.8.12 work.

---

## Verified

- 13 unit tests on `cancellable-drive-update.js` covering the new
  `getDriveSize()` helper (sums metadata + blob, tolerates missing
  blob core, best-effort under timeout)
- 165 / 165 in the full v0.8.11 test bundle (auto-heal, custody,
  publish channel, seed request builder, client SDK, api transient
  errors, etc.) — every test still passing
- Lint clean across all changed files

---

## Compatibility

- **Backward-compatible with v0.8.10 publishers** that explicitly
  set `maxStorage` to a value larger than their drive size — they
  see no behavior change.
- **Backward-compatible with v0.8.10 publishers** that left
  `maxStorage` at the SDK default — they now get a larger default
  (1 GB) when the drive isn't locally accessible, and a computed
  default (drive size × 4) when it is. Either is strictly better
  than the prior 500 MB.
- **Backward-incompatible with v0.8.10 publishers** that explicitly
  set `maxStorage` *smaller* than their drive size — these previously
  succeeded silently with a broken partial pin; they now fail
  loudly with a `seed-aborted` event. This is the bug fix.

---

## Migration for publishers using HiveRelay

If you have an existing pin script that worked under v0.8.10:

```js
// v0.8.10 — silently broken if drive > 256 MB
await client.seed(driveKey, {
  replicas: 5,
  ttlDays: 365,
  maxStorage: 256 * 1024 * 1024
})
```

Upgrade to:

```js
// v0.8.11 — sizes correctly, emits events
const driveBytes = (drive.db?.core?.byteLength || 0) +
                   (drive.blobs?.core?.byteLength || 0)
const maxStorage = Math.max(256 * 1024 * 1024, driveBytes * 4)

client.on('seed-aborted', (info) => {
  console.error('Pin aborted:', info.hint)
  process.exit(2)
})

await client.seed(driveKey, { replicas: 5, ttlDays: 365, maxStorage })
```

See `docs/PUBLISHING.md` for the full template and `verify-pin` pattern.

---

## Acknowledgements

This release is a response to a high-quality bug report from the
pearbrowser-desktop maintainers
(`docs/FEEDBACK-PEARBROWSER-PIN-CAP-FAILURE.md`). They both diagnosed
the problem cleanly and proposed the exact fix shape — turning an
hour-long invisible debug session into a one-release upstream patch.
The bug report is filed in `docs/` as a permanent record so future
publishers can understand the trap before they hit it.
