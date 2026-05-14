# Feedback: silent partial-pin failure (PearBrowser case study)

> **TL;DR.** Relays accept a seed request whose `maxStorage` is smaller than
> the drive's actual `byteLength`. They replicate metadata fully, stall
> mid-blob, and never tell the publisher. End users running
> `pear run pear://<key>` experience a silent indefinite hang on first
> launch — same symptom as "no peers found", but the publisher's own
> diagnostic (`pear info`) and the relay client's `seeded` callback both
> say everything is fine. This took an hour to diagnose because the
> failure is invisible from both sides.

Filed by: pearbrowser-desktop maintainers
Date: 2026-05-14
HiveRelay version: 0.8.5 (client) / 0.8.10 (monorepo head)
Related code:
- `packages/core/relay-node/app-lifecycle.js:179-227` (relay's drive replication loop)
- `packages/client/index.js` `seed(key, opts)` (publisher seed request)
- `packages/core/protocol/seed-request.js` (wire schema)

---

## What happened

PearBrowser desktop is published as a single Hyperdrive
(`pear://tco5k7h38uoxatedp1wongdbhjxow1x7jiwm3t1i9cujbebhsbty`). As of
`v0.4.3` the drive is:

```
metadata core:        length 4914,  byteLength    1,236,505    (~1.2 MB)
content (blob) core:  length 10119, byteLength  381,674,831    (~364 MB)
total:                                          382,911,336    (~365 MB)
```

The publisher's pin script asked five relays to pin with these options:

```js
{
  replicas: 5,
  ttlDays: 365,
  maxStorage: 256 * 1024 * 1024,  // 256 MB — set when the drive was 9 MB
  region: null
}
```

The four relays that responded all emitted a `seeded` event with
`acceptances === 4`. From the publisher's perspective: success.

Reality on the relays: `drive.update({ wait: true })` succeeds (small),
`drive.download('/')` runs until it hits the 256 MB allocation, then
either silently throws inside the `Promise.race().catch(() => {})` at
`app-lifecycle.js:222` or stops fetching new blocks for the content
core. The drive stays in `this.apps` with `version: 4914`, the
`reseeded` event still fires, the gateway endpoint
`/v1/hyper/<key>/index.html` works (it serves cached blocks), but
roughly 30% of blob blocks are missing.

End users on a fresh machine:
1. `pear run pear://tco5...` resolves DHT, finds the relay, syncs
   metadata (`length=4914` arrives within seconds)
2. Hyperdrive starts walking the manifest, requesting blob blocks
3. For blocks the relay never finished downloading, the block request
   hangs waiting for *some* peer to serve them. There is none.
4. Terminal sits silent forever. No error, no progress.

Indistinguishable from a network-unreachable bug.

---

## How we reproduced and verified

Wrote a `verify-pin.js` script for the publisher side that does what
`pin-self-on-hiverelay.js` does *not*:

1. Fresh `mkdtempSync` corestore — zero local cache
2. New `Hyperswarm`, join the drive's discovery topic
3. Wait for any peer connection
4. `drive.core.update({ wait: true })` — read length
5. `drive.list('/')` to find a real file
6. `drive.get(<file>)` with a 20-second timeout
7. Exit non-zero if the blob fetch times out

Output before the fix:

```
→ waiting for peers... ✓
→ reading drive length... length=4914
→ sampling a blob... ✗
blob sample failed: blob fetch timed out
metadata is reachable but content blocks are not — partial pin
```

After bumping `maxStorage` to 1 GB and waiting for the relays to backfill
the missing ~30% of blob blocks, the same script returns a real blob
within seconds.

So the bug reproduces deterministically and the fix is real.

---

## What we'd like HiveRelay to change

Ordered by severity. (1) and (2) are correctness; (3) and (4) are UX.

### 1. Reject seed requests when `maxStorage < drive.byteLength`

**Right now**: relay accepts the request, ACKs `accepted: true`, and
starts replicating with no awareness that it can't fit the drive.

**Should**: in the relay's `_onSeedRequest` handler (around the point
where it calls `seedApp(key, opts)`), compute the drive's total byte
size *after* the first `drive.update({ wait: true })`. If
`drive.byteLength + drive.blobs.byteLength > opts.maxStorage`, respond
with `accepted: false, reason: 'maxStorage too small'` and include
the actual size so the client can retry with a bigger cap.

This is the single most important fix. It turns a silent invisible
bug into a loud immediate one. The publisher learns the truth at pin
time, not after deployment.

Note: drive size is unknowable *before* first sync, so the check
must run after metadata arrives, not at request-accept time. The
relay can ACK acceptance, attempt sync, then emit a follow-up
`seed-aborted` message if the size doesn't fit. Either pattern is
fine — what matters is the publisher hears about it.

### 2. Emit `seed-progress` and `seed-stalled` events to the publisher

The relay knows whether `drive.download('/')` is progressing. It
should send back periodic progress updates (`downloadedBlocks /
totalBlocks`, or `downloadedBytes / totalBytes`), and an explicit
`seed-stalled` event when the download stops making progress for >30s
without completing.

The client SDK can re-emit these as `seed-progress` and `seed-stalled`
events on the `HiveRelayClient`. Then a pin script can sit on the
events and print a real progress bar instead of treating the initial
ACK as the final word.

### 3. Provide a content-availability query

Add a `client.queryContent(driveKey)` that asks N relays "do you
currently have all of this drive's blob blocks". Returns
`{ relayPubkey, version, blockCoverage: 1.0 | 0.7 | 0.0, ... }`.

Today the only way for a publisher to know whether end users will
have a working experience is to do what `verify-pin.js` does — boot
a fresh corestore in a temp dir and try fetching a blob. That's
heavyweight for what should be a simple RPC.

### 4. Sane default `maxStorage` in the client SDK

The current default — whatever `seed()` falls back to when `opts` is
omitted — should be a reasonable size for the drive being seeded.
Either:
- compute it from `drive.byteLength + drive.blobs.byteLength` plus a
  growth multiplier (e.g. 4×), OR
- make `maxStorage` a *required* argument with a clear error
  ("specify maxStorage in bytes — at least drive.byteLength")

The current "256 MB default that you have to know to override" is a
trap. Every Pear app project that grows past 256 MB will hit this
silently, because nobody re-reads their pin script after their first
release works.

### 5. Document the failure mode

Add an entry to `docs/DEVELOPER.md` (or a new `docs/PUBLISHING.md`)
explaining:

- `maxStorage` is per-app on each relay, not total
- It must exceed `byteLength + blobs.byteLength` from `pear info` or
  `drive.byteLength`
- `pear-electron` and other "bundles runtime into the drive" stacks
  inflate drive size by 30-400 MB
- The symptom of getting this wrong: `pear info` works, `pear run`
  hangs — looks like a network bug, isn't
- Recommended pattern: a `verify-pin` script that round-trips a blob
  from a fresh corestore after every pin

---

## What we already did on our end

Not a request — just so you can see the shape of a workaround
without these fixes:

- **`scripts/pin-self-on-hiverelay.js`** — bumped `maxStorage` from
  256 MB to 1 GB with a big comment about how to size it and what
  goes wrong when it's too small.
- **`scripts/verify-pin.js`** — fresh-corestore round-trip blob
  fetch, exits non-zero on failure. Pasteable into any other Pear
  project that uses HiveRelay.
- **`scripts/release-prod.sh`** — now does `stage → release → pin →
  verify-pin` in one. The verify step polls up to 10 minutes;
  if it never passes, the release script exits 2. A future
  v0.4.x release literally cannot ship "succeeded but unreachable"
  anymore.

These workarounds suffice for our project, but they don't generalize.
Every project publishing through HiveRelay will hit the same trap
unless the relay side gets at least fixes (1) and (4).

---

## Out of scope

- We are **not** asking for the relay to auto-grow `maxStorage` —
  that would let any publisher fill a relay's disk. The publisher
  should always declare a real cap.
- We are **not** asking for the relay to retry rejected seed
  requests automatically.
- We are **not** asking for changes to the seed protocol's
  cryptographic envelope (signed-seed Ed25519). That part works.

---

## Contact

If you want to look at the failing-then-fixed reproduction:

```
git clone https://github.com/bigdestiny2/pearbrowser-desktop
cd pearbrowser-desktop
node scripts/verify-pin.js --expect 4914
# pre-fix output: "blob sample failed: blob fetch timed out"
# post-fix output: "Drive is fully reachable"
```

The pearbrowser-desktop maintainers will help debug or run experiments
on the production drive at any time — it's a useful real-world load
test (365 MB drive, deployed, has actual end users).
