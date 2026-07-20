# P2Poker generic relay lifecycle handoff

**Status:** local-only review material; no remote action performed  
**Prepared:** 2026-07-20  
**Release base:** Hive Relay `0.24.3` at `5a7e6f472110c5bfdb9d37411340688430750fcd`  
**Reviewed tip:** `bb764372b41aabbebc7693971e3e6f5f108d0b6c`

## Immutable commit stack

The reviewed history is linear and exact:

```text
5a7e6f472110c5bfdb9d37411340688430750fcd
  -> 4b14615dbc055fb388fd52b27f06ca961a09c328
  -> 3db878c47b226612c2842858de8957ca5e3cbd82
  -> bb764372b41aabbebc7693971e3e6f5f108d0b6c
```

The commits contain only the following files:

| Commit | Subject | Exact files |
|---|---|---|
| `4b14615dbc055fb388fd52b27f06ca961a09c328` | `test(services): prove relay rate-limit config is ignored` | `test/unit/relay-node.test.js` |
| `3db878c47b226612c2842858de8957ca5e3cbd82` | `fix(services): honor configured relay request budgets` | `packages/core/core/relay-node/index.js`; `packages/core/core/relay-node/bare-relay.js`; `test/unit/bare-relay-surface.test.js` |
| `bb764372b41aabbebc7693971e3e6f5f108d0b6c` | `feat(client): dial relays learned out of band` | `packages/client/index.js`; `test/unit/client-direct-relay.test.js` |

The aggregate range `5a7e6f4..bb76437` is six files, 120 insertions, and two deletions.

## Generic capability summary

- Relay operators can pass `serviceRateLimitMax` and `serviceRateLimitWindow` into both the Node and Bare `ServiceProtocol` constructors. This is generic request-budget propagation.
- Clients can call `connectRelay(pubkeyHex, { timeoutMs })` for a relay public key learned out of band. The method validates the 64-character hexadecimal key, uses direct Hyperswarm peer dialing, returns immediately for an existing service channel, waits for the requested relay only, and resolves `false` when the bounded wait expires.
- These capabilities support generic signed-log availability and connectivity. They do not add application semantics to the relay.

## Test and lint evidence

Authoritative focused run from WSL2 with Node `v22.22.2`, so POSIX owner-mode assertions are meaningful:

```text
npm exec brittle -- \
  test/unit/client-direct-relay.test.js \
  test/unit/relay-node.test.js \
  test/unit/bare-relay-surface.test.js

42/42 tests pass
202/202 assertions pass
exit 0
```

The same run under native Windows reached 200/202 assertions; its only failures were the two pre-existing POSIX file-mode checks because NTFS reports `0666` rather than `0600`. All direct-dial, configured-budget, and Node/Bare parity assertions passed there as well. The WSL2 run closed those platform-only checks without changing source or tests.

Changed-file Standard lint:

```text
npm exec standard -- \
  packages/client/index.js \
  packages/core/core/relay-node/index.js \
  packages/core/core/relay-node/bare-relay.js \
  test/unit/client-direct-relay.test.js \
  test/unit/relay-node.test.js \
  test/unit/bare-relay-surface.test.js

exit 0
```

## Excluded dirty baseline

The following unrelated modifications existed before this release preparation and are excluded from every stage and commit:

| Path | Baseline SHA-256 on 2026-07-20 |
|---|---|
| `packages/core/cli/index.js` | `525DEB29E6F0E04609111BF8915DE2CAA2A3DD3DDC8E253C87F18EF2BFDE5596` |
| `packages/verifier/bin/verify.js` | `C17A63AF1C282D2CBE88AC1CEED0D057EB0B828B54999C1D47711446D07BC67F` |

They must remain byte-for-byte unchanged, unstaged, and uncommitted.

## Card-blind and authority boundary

> **BRIGHT LINE:** Hive Relay remains an opaque, generic signed-log availability, ordering, request-budget, and connectivity substrate. No card values, deck order, poker rules, player actions, outcomes, balances, settlement decisions, private decryption shares, secret reconstruction, or authorization to move value crosses into relay responsibility.

Review must reject any change that lets the relay inspect cards, decide poker legality or outcomes, reconstruct private material, compute balances, or authorize settlement. The reviewed files only propagate operator-configured request budgets and dial an explicitly supplied relay public key.

## Proposed pull request

**Title:** `feat: expose generic relay request budgets and direct public-key dialing`

**Body:**

```markdown
## Summary

- forward configured service request budgets into ServiceProtocol in Node and Bare runtimes
- expose a bounded client API for dialing a relay public key learned out of band
- keep network unavailability as an explicit `false` result while rejecting malformed keys

## Scope

This is generic signed-log availability and connectivity infrastructure. It does not add card, poker-rule, outcome, balance, secret-reconstruction, or settlement authority to Hive Relay.

## Verification

- client direct-relay unit contract
- RelayNode configured-budget contract
- Node/Bare source-parity contract
- Standard lint on all six touched source/test files

Focused result: 42/42 tests and 202/202 assertions pass under Node 22 on WSL2.
```

## Reviewer checklist

- [ ] Confirm the parent chain is exactly `5a7e6f4 -> 4b14615 -> 3db878c -> bb76437`.
- [ ] Confirm the commit inventory is exactly the six files listed above.
- [ ] Confirm public-key validation, idempotent already-open behavior, bounded wait, relay-specific event matching, and `false` on unreachable relay.
- [ ] Confirm `serviceRateLimitMax` and `serviceRateLimitWindow` reach `ServiceProtocol` symmetrically in Node and Bare.
- [ ] Confirm no card, game-rule, outcome, balance, private-share, secret-reconstruction, or settlement logic is introduced.
- [ ] Confirm package preparation includes only the declared manifests, lockfile, changelog, and this handoff.
- [ ] Confirm the excluded dirty baseline remains unstaged and byte-for-byte unchanged.

## Explicitly not performed

- No branch or commit was pushed.
- No pull request was created, updated, commented on, reviewed, approved, or merged.
- No package was published and no registry was mutated.
- No release, tag, deployment, relay-fleet change, upload, signing ceremony, paid API call, or on-chain transaction was performed.

