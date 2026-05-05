# HiveRelay 0.8.3 — Bug Hunt

Released: 2026-05-05

A focused fix release responding to a bug report from a real Mac mini
operator running a relay in production. Six bugs killed or one
patched.

If you're upgrading from v0.8.2, no migration required. All fixes are
backward-compatible.

---

## Critical fixes

### Bug #1 — Null `discoveryKey` crash on startup (recurring across v0.3.0–v0.8.2)

```
TypeError: Cannot read properties of null (reading 'buffer')
    at b4a.toString(existing.discoveryKey, 'hex')
```

The `AppRegistry.load()` populates `this.apps` with placeholder
entries whose `discoveryKey: null` (set later during reseeding).
`seedApp()`'s "already seeded — no-op" branch ran first and tried
to stringify the null key, crash-looping the process via launchd /
systemd.

This bug has shipped in **four+ versions**. v0.8.3 fixes it
permanently: when the no-op branch encounters a null discoveryKey, it
falls through and seeds for real. Both the pre-mutex and post-mutex
checks are guarded.

### Bug #2 — `EADDRINUSE` on self-heal restart

When the health monitor restarted the node under memory pressure, the
new bind to `0.0.0.0:9100` failed because the OS socket hadn't fully
released. The relay entered a zombie state — `/health` returned `ok`
but `running: false`, no public key, no seeding.

v0.8.3 wraps the API server's `listen()` in an exponential-backoff
retry loop (1s/2s/4s/8s/16s, max 5 retries). Catches `EADDRINUSE`,
recreates the server, and tries again. Emits `api-bind-retry` events
so operators can see the recovery happening.

### Bug #3 — Memory threshold too aggressive at 144 MB RSS

The health monitor triggered `health-critical` (which fires self-heal
restart) on `heapPct > 95% OR rssMB > 512MB`. V8 routinely runs near
95% heap before garbage collection, which produced false-positive
CRITICAL events at 144 MB actual RSS.

v0.8.3 changes two things:
- Heap threshold raised from 95% → 98% (closer to true OOM trajectory)
- Memory pressure now requires **BOTH** high heap AND high RSS, not
  either. V8's normal pre-GC behavior alone no longer triggers a
  restart.

---

## Quality-of-life fixes

### Bug #4 — `drive.update` retry strategy gave up forever after 6 tries

The eager-replicate retry loop in `seedApp()` ran 6 times with
backoffs (5s/10s/15s/30s/60s/120s) and emitted `'max retries
exceeded'` — making it look permanent. The periodic repair monitor
DOES keep trying, but the misleading error message and the wasteful
120s tail wait obscured that.

v0.8.3:
- Tail backoff capped at 30s (down from 120s), total wall ~2 min
- Error renamed: `'eager-replicate-exhausted'` with `recoverable: true`
  and a hint that the repair monitor will keep trying
- Repair monitor default interval reduced 10 min → 5 min

### Bug #8 — `p2p-hiverelay seed <key>` looked like it wasn't doing anything

The CLI command's `/seed` endpoint was already calling `node.seedApp()`
locally, but the eager-replicate runs in the background — operators
saw "Seeded" then watched their relay sit at zero apps for a couple
of minutes and concluded local seeding wasn't working.

v0.8.3 clarifies the CLI output:

```
✓ Registered for local seeding: <appKey>
  Discovery key: <hex>
⏳ Replication runs in the background (typically ~5-30s if peers are online).
   Use 'p2p-hiverelay status' to see anchor state.
```

### Bug #12 — `p2p-hiverelay --version` flag

Added. Returns `0.8.3`. Previously you had to grep `help` output or
use `npm ls -g`.

---

## New: `p2p-hiverelay doctor`

Diagnostic command that catches the class of problem where you've
upgraded the npm package but your launchd plist / systemd unit /
config still reflects an older version's defaults.

```bash
p2p-hiverelay doctor       # report drift
p2p-hiverelay doctor --fix # auto-write recommendations to ~/.hiverelay/config.json
```

Reads `~/.hiverelay/config.json` + the running relay's `/catalog.json`,
compares against what v0.8.x expects, and reports/fixes:

- Region not declared → AutoHeal diversity scoring on peer relays misses you
- Operator not declared → sybil resistance falls back to pubkey-as-operator
- AutoHeal not enabled → no diversity-enforced replica recruitment

Catches the exact situation that hit the Mac mini operator: v0.8.2
binary running, but the launchd plist's `ProgramArguments` didn't
include `--region`, `--operator`, or `--auto-heal`.

---

## Deferred to v0.8.4

- `hiverelay-meta` Protomux channel for capability gossip (so peers
  can see each other's version + region + operator without polling)
- `p2p-hiverelay manage --json` mode (non-TTY automation)
- TUI "update" command actually running `npm install` instead of just
  restarting the running process

---

## Verified

- 67/67 unit tests pass across affected files
- Lint clean
- All 4 npm packages publish at 0.8.3
- All 3 production VPS relays redeployed cleanly
- Mac mini upgrade path verified — `doctor --fix` writes correct config

---

## Honest acknowledgment

The Bug #1 null-discoveryKey crash should never have shipped in 4+
versions. The pattern was a defensive guard at the read site each time,
which papered over the symptom but never addressed the placeholder-
entry pattern in `AppRegistry.load()`. v0.8.3 fixes it at the right
layer. We don't expect this one to come back.

The deploy script bug (cli/index.js path) caught earlier in the
v0.8.1 canary is also a "real fix at the right layer" rather than a
local patch.

These bugs are real failures of upstream care — every time we shipped
without catching them was a missed test/review. Moving forward, every
new "AppRegistry.apps" Map mutation + every systemd ExecStart change
will be on the explicit checklist for code review.
