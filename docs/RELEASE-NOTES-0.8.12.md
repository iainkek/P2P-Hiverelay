# HiveRelay 0.8.12 — Re-Pin Honors New Opts

Released: 2026-05-14

Structural follow-up to v0.8.11. Closes ask (6) from
`docs/FEEDBACK-PEARBROWSER-PIN-CAP-FAILURE.md`. Triggered by a
maintainer-side bounce request from the pearbrowser-desktop team after
they discovered their v0.8.10-era partial-pinned drive couldn't be
retriggered by a v0.8.11 re-pin (because `seedApp`'s `alreadySeeded`
early-return swallowed the new opts).

If you're upgrading from v0.8.11, no migration required. The behavior
change is invisible until a publisher re-pins an already-seeded app
with new opts — at which point the relay now honors the change
instead of returning `alreadySeeded` and discarding them.

---

## The bug we're fixing

The pearbrowser-desktop maintainers found this one cleanly:

> Your v0.8.11 fix landed correctly and works on fresh seeds. But our
> production drive was already partial-pinned at 256 MB before v0.8.11
> rolled out, and the relay's `seedApp()` early-return on `alreadySeeded`
> means our 1 GB re-pin never reaches `_seedAppInner` to re-validate or
> re-trigger `drive.download('/')`. The relays are sitting on incomplete
> blob state.

The structural shape: `seedApp(appKey, opts)` looks up the key in
`seededApps`, finds an existing entry, returns `{ alreadySeeded: true }`
without examining `opts`. If a publisher re-pinned with a larger
`maxStorage` to unblock a previously-partial drive, the relay
discarded the new cap and kept doing nothing.

Until this fix, the only unblock was to restart the relay: the fresh
process loaded the registry, called `seedApp` with no cap (because
maxStorage wasn't persisted), and downloaded the whole drive on the
new code path. Operators had to manually bounce nodes to clear
partial state. Not sustainable.

## The fix

### `_reconcileSeedOptsOnRepin` (new method)

When `seedApp` hits the `alreadySeeded` branch, instead of returning
early, it now calls `_reconcileSeedOptsOnRepin(appKey, existing, opts)`
before returning. The decision table for `opts.maxStorage`:

| Condition                              | Action                                                                |
| -------------------------------------- | --------------------------------------------------------------------- |
| Same cap (or both null)                | No-op (matches prior behavior).                                       |
| Cap raised (or set where old was null) | Update entry's cap, emit `seed-cap-raised`, retrigger `_eagerReplicate` to drain blocks the prior cap had blocked. |
| Cap lowered                            | Emit `seed-cap-warning` (`reason: 'cap-lowered-on-repin'`). Keep the prior higher cap — we don't shrink already-accepted capacity. |

Concurrency: an in-flight retrigger is tracked via `entry._replicating`
so rapid re-pins don't stack. If a retrigger is already running, the
new cap is updated on the entry but no second replicate is spawned —
the in-flight one sees the larger cap via the entry reference, and
the periodic repair monitor uses the latest `entry.maxStorage` on
its next sweep regardless.

The reconcile applies on both the pre-mutex and post-mutex
`alreadySeeded` checks in `seedApp` / `_seedAppInner`.

### `_eagerReplicate` extracted as a method

What was previously an inline closure inside `_seedAppInner` is now a
class method:

```js
async _eagerReplicate (appKeyHex, drive, opts, meta = {}) { ... }
```

Same retry-with-backoff (6 retries, ~2 min wall), same size-check
against `opts.maxStorage`, same `downloadWithTimeout(drive, '/')`,
same anchor + custody-receipt path. Callable from:

1. `_seedAppInner` — fresh seed (`meta.source = 'fresh-seed'`).
2. `_reconcileSeedOptsOnRepin` — re-pin retrigger (`meta.source =
   'repin-cap-raised'`).

The `source` field is forwarded on emitted `seed-aborted`,
`anchored`, `reseeded`, and `reseed-error` events so operators can
distinguish first-replication failures from re-pin failures.

### Per-app `maxStorage` persistence

`AppRegistry` now tracks `maxStorage` on each entry and persists it
in `app-registry.json`. This is what lets the reconcile path compare
caps across restarts without having to ask the publisher to re-send
the cap on every startup.

Backward compatibility: entries that predate this field load as
`maxStorage: null` and behave as if no cap is declared (matches
v0.8.11). On reseed at startup, `reseedFromRegistry` passes the
persisted cap back through `seedApp`, so the v0.8.11 size-check now
fires on startup too — it used to be skipped because the cap was
forgotten between restarts.

## Events surface

New / extended events on `RelayNode` (forwarded through `AppLifecycle`):

- **`seed-cap-raised`** — emitted when a re-pin raises the cap.
  Payload: `{ appKey, oldCap, newCap, anchored, hint }`. Operators
  can use this to confirm that a publisher's re-pin reached the
  relay and that the retrigger is starting.

- **`seed-cap-warning`** with `reason: 'cap-lowered-on-repin'` —
  emitted when a re-pin tries to lower the cap. Payload:
  `{ appKey, reason, oldCap, newCap, hint }`. Operator can decide
  whether to take action; the relay keeps the higher cap.

- **`seed-aborted`, `anchored`, `reseeded`, `reseed-error`** — now
  include `source: 'fresh-seed' | 'repin-cap-raised'` so the
  observability stream distinguishes initial-replication outcomes
  from re-pin-driven outcomes.

## What it does NOT do (deferred)

The other two items from the pearbrowser-desktop feedback remain
deferred:

- **Ask (2)** — `seed-progress` / `seed-stalled` push events over
  the seed Protomux channel. Designed but not yet implemented;
  ergonomics nice-to-have, no operator pain in shipping without it.
- **Ask (3)** — `client.queryContent(driveKey)` RPC. Useful for
  block-coverage queries from clients before they pick which relay
  to dial. No active pull from publishers right now; deferred.

## Verified

- 12 new unit tests in `test/unit/repin-cap-reconcile.test.js`:
  same-cap no-op, both-null no-op, cap raised, cap newly declared,
  cap lowered, in-flight retrigger guard, missing-drive guard,
  closed-drive guard, invalid-cap normalization, and the
  `AppRegistry` round-trip for the new `maxStorage` field.
- `AppRegistry.update` preserves `maxStorage` when not in updates
  (verified).
- `_reconcileSeedOptsOnRepin` returns without throwing on all
  scenarios (verified).
- `_eagerReplicate` extracted method behaves identically to the
  prior closure for fresh-seed path (same retry counts, same delays,
  same emit signatures) — code-level inspection plus the existing
  v0.8.11 `cancellable-drive-update` tests still pass (13/13).

## Compatibility

- **Backward-compatible with v0.8.11 publishers**: same-cap re-pins
  are still a no-op; raised-cap re-pins newly work.
- **Backward-compatible with pre-v0.8.12 `app-registry.json`**:
  entries without `maxStorage` load as `null` and are not
  retroactively size-checked on reseed.
- **Behavior change for v0.8.12+ entries on reseed**: the size-check
  now fires on startup too. If a drive has grown beyond its declared
  cap between when it was pinned and when the relay restarts, the
  relay emits `seed-aborted` and unseeds locally. This is the same
  loud failure mode v0.8.11 introduced for fresh seeds; v0.8.12
  extends it to startup-reseeds for entries that have the cap
  persisted.

## Migration

None required. Existing pin scripts and SDK calls work unchanged.

Publishers who re-pin already-seeded apps with a larger cap will
now see the relay retrigger replication instead of silently keeping
the partial state. The relay emits `seed-cap-raised` for
observability.

If you want to listen for the new events from a pin script:

```js
client.on('seed-cap-raised', (info) => {
  console.log('Relay accepted cap raise:', info)
})
client.on('seed-cap-warning', (info) => {
  if (info.reason === 'cap-lowered-on-repin') {
    console.warn('Relay did NOT honor cap reduction:', info)
  }
})
```

---

## Acknowledgements

The pearbrowser-desktop maintainers diagnosed this cleanly — they
identified the exact line range in `app-lifecycle.js`, traced the
control flow that swallowed the new opts, and proposed the bounce
workaround that got them unblocked while we shipped this fix. The
quality of the bug report turned a structural fix into a one-release
patch.

The original v0.8.10 silent-partial-pin trap that started this is at
`docs/FEEDBACK-PEARBROWSER-PIN-CAP-FAILURE.md`. The bounce request
itself was a one-shot doc filed in the pearbrowser-desktop repo, not
ours.
