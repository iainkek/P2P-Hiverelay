# P2Poker — playtest review (player's perspective)

A deep review of every user flow from the perspective of a real human sitting down
to play and to test the real-money rail on testnet. Living doc — updated as the
review loop runs.

## Browser table client — module BUILT + verified (iteration 18)

Wrote `money/relay-table-client.js` (served same-origin via `/poker-engine`) — the
browser module that makes the dashboard a real seat. WebCrypto Ed25519 (no vendored
crypto) signs moves the relay accepts; works in any secure context (localhost dev +
https prod). API: `createSeat()` / `restoreSeat()` (persist a seat across reloads,
PKCS8), `signEntry()`, and a `RelayTable` wrapper (`createTable`/`postMove`/`readLog`/
`listTables`).

Verified end-to-end in a browser on the **real relay** (same-origin, localhost
secure): `createTable` → 201; a WebCrypto-signed move → accepted + in the shared log;
a tampered signature → 422; a **persisted seat key restores and re-signs** correctly;
no JS errors. (Also confirmed `crypto.subtle` Ed25519 is available on localhost — the
about:blank failure earlier was just a non-secure context.)

**Remaining for playable multiplayer:** a table UI that drives this client (create/
join, post each betting action as a signed move, poll the log, replay via
`betting.js`), plus trustless dealing (the relay is card-blind — the poker bundle
ships VRF for this). The networking + identity + signing layer is now done and
proven.

## Browser table client — DE-RISKED (iteration 17)

The one piece left for real two-human play is a browser client that signs + posts
moves to the relay log. Its only real unknown was **in-browser ed25519 signing** (the
relay verifies with sodium; browsers have no sodium). Proven solvable:

- **Canonical bytes** (`_canonicalEntry`) are plain string-concat + UTF-8 — reproduced
  in ~3 lines, byte-identical (the format is explicitly cross-runtime).
- **Signing**: `@noble/curves` ed25519 (pure JS, browser-ready) produces signatures
  the relay's `sodium.crypto_sign_verify_detached` **accepts** — verified against the
  local relay: create-table with a noble pubkey → 201; a noble-signed move → `{ok:true}`
  and lands in the log; a **tampered** signature is rejected (422 bad-sig).

So every layer of real multiplayer is now proven: canonical bytes ✓, browser ed25519
✓, relay table API ✓, reduce→settlement ✓ (iter 16), escrow on-chain ✓. **What's left
is pure wiring**: vendor a browser noble bundle, write a `relay-table-client.js`
(create/join, sign+post moves, poll the log), and render the table from the shared
log instead of local bots. No unsolved primitives remain.

## Multiplayer substrate — PROVEN on a local relay (iteration 16)

The remaining frontier (two humans, on-chain settlement) needs a relay table that
both players write to. Enabled the relay's built-in **poker service** locally
(`services.json: {enabled:true, plugins:["poker"]}` in `~/.hiverelay/storage`, which
expands to poker+vrf+arbitration+zk) and ran the relay-integration smoke
(`fra/play-on-fra.mjs`) against the **local** relay:

- `POST /api/poker/tables` (two writers) → **201**.
- Both seats `POST /api/poker/<key>/move` signed entries → **200** (log indices 0,1).
- `GET /api/poker/<key>/log` → 2 entries → `reduce()` → **`illegal: null`**,
  deterministic `sessionHash`, balances `{alice:+30, bob:−30}` → on-chain final
  **alice 130 / bob 70 USD₮**.

So a hand on the relay's signed log **reduces to exactly the settlement the escrow
pays** — the whole substrate (relay table API → signed log → reducer → on-chain
balances) works end-to-end locally. **What's left for real two-human play is the
browser table client** (post each action as a signed move + render from the shared
log instead of local bots); the relay API, the reducer, the escrow, and the settle
UI are all proven.

## Verified against a REAL relay node (iteration 15)

Everything before this was tested against a mocked static server. Booted an actual
local relay (`p2p-hiverelay start --port 8790`) and confirmed the whole money-rail
surface works when served by the **real `api.js`**, not a mock:

- `/lobby` `/table` `/cashier` all serve 200; the real CSP is
  `script-src 'self' 'unsafe-inline'` / `connect-src 'self' ws: wss:`.
- `/poker-engine/{betting.js, hand-eval.js, ethers.umd.min.js, poker-artifacts.json}`
  all serve 200 (artifacts as `application/json`); `/poker-engine/api.js` correctly
  404s — the whitelist holds against the real route.
- In a browser on the real relay: **ethers loads same-origin under the real CSP**
  (zero violations), artifacts fetch + parse, the self-serve **Deploy** button is
  wired, and the co-sign digest is **byte-valid** via real-relay-served ethers. So
  M2 (F10), the artifacts (F11), and the cashier live flow are confirmed in
  production-equivalent conditions, not just under the mock.
- **Local relay boots cleanly here** — so the multiplayer build *can* be developed +
  verified against a local relay (no need to touch the live FRA relay). That's the
  unblock for the remaining frontier.

## Certification (iteration 10 — full regression sweep)

Everything reviewed across 10 iterations is green together, no regressions:

- **Product suites:** off-chain 83/83 · on-chain 31 passing · dashboard routes 5/5.
- **Browser flows (headless):** table net/badges, keyboard play, lobby→table,
  ethers-under-strict-CSP + co-sign digest, self-serve deploy + solo settle — all
  pass (31 assertions across 5 harnesses).
- **12 issues found & fixed + 4 platform wins** (hotkeys, same-origin ethers,
  self-serve escrow deploy, one-click solo settle). See below.

**What a real human can do on testnet today, self-served:** open `/lobby` → play
hold'em vs bots (hotkeys, net readout, mobile-friendly); open `/cashier` → Live →
*Deploy a test escrow* on Base Sepolia → deposit → settle → withdraw real testnet
USD₮, one click per step, with an on-chain-valid co-sign. **Nothing needed from the
operator.**

**The one remaining frontier (not built):** two real humans playing the same
real-money *hand* that settles on-chain. The table is a local bot demo; it isn't
joined to the relay (shared multiplayer state) or to the escrow (settling actual
gameplay). That needs the relay-multiplayer + table→reducer→escrow wiring — every
piece (betting engine, reducer, escrow, signed-log) exists and is tested
individually, but joining them needs a running relay (FRA key or a local relay
instance), so it can't be built+verified in this review loop. Scope below.

## Verified working (headless drive, 0 JS errors)

- **Table** — 2 / 6 / 9-max, full betting (fold/check/call/bet/raise/all-in +
  quick-bet), bots, side pots, street-by-street board, showdown by real hand
  strength, re-buy on bust, juice (badges, card-flip, ship, strength readout),
  sound toggle. Drove 12 hands mixing all actions incl. all-ins and a bust→re-buy —
  no errors. Drives the **real** engine over `/poker-engine`.
- **Cashier** — demo lifecycle (connect→deposit→settle→withdraw→new session),
  lifecycle stepper, win/loss banner, live-mode config + cooperative co-sign
  section, and the **table-session bridge** (reads the table's net from
  `localStorage` — correctly showed "-1090 over 5 hands").
- **Lobby / hub / nav / routing** — all pages reachable, cross-linked; HTTP nav
  verified end to end.
- **On-chain escrow** — BOTH settlement paths proven on Base Sepolia (cooperative +
  committee dispute), escrow drains to 0 each time. Suites: 83 off-chain + 31
  on-chain + 5 routing, all green.
- **Cashier live co-sign is on-chain-valid** — the in-browser `coopDigestHex` is
  **byte-identical** to `settle.cjs` (verified `0x883c9c90…` for a fixed input), and
  an EIP-191 signature over it recovers to the signer (matches the contract's
  `_recover`). So a real tester's cooperative co-sign produced in the browser will
  verify on-chain. The live deposit/withdraw/connect paths mirror the tested
  `EscrowClient`, with failures surfaced to the activity log.

## Bugs found & fixed (this review)

- **F1 — "Net this session" stuck at 0.** The N-seat rewrite dropped the `#net`
  update in `render()`; `T.net` was computed + persisted but never shown, so a
  money tester couldn't see winnings/losses. **Fixed** (render writes it; green/red;
  no `+` on zero). Verified: shows -1000 after busting an all-in.
- **F2 — stale badges/ship into the next hand.** Action badges and the pot-ship
  lingered onto a fresh deal. **Fixed** (cleared at `startHand`). Verified: 0 stale
  elements at a fresh deal.
- **F3 — bot name "Юki"** had a stray Cyrillic char. **Fixed** → "Quinn".
- **F4 — cashier live-mode count-up flash.** Demo→live animated the stats down from
  the demo numbers (~0.4s flash). **Fixed** (snap the displays on mode switch).
  Verified: live wallet shows 0.00 immediately.
- **F5 — 9-max clipped a seat on mobile.** On a phone, a side seat's cards ran off
  the edge at 9-max (6-max + heads-up were fine). **Fixed** (pull seats inward on
  narrow screens — smaller seat radius < 560px). Verified: 0 clipped at 9-max,
  6-max still 0 clipped + playable, 0 JS errors on mobile.

- **F6 — live deposit could revert on a laggy testnet RPC.** `liveDeposit` approved
  then immediately deposited; on a public RPC that lags read-after-write (the exact
  failure I hit deploying to Base Sepolia), `deposit`'s gas estimate sees a stale
  allowance and reverts `TRANSFER_FROM_FAILED`. **Fixed** (poll the allowance to
  propagate after approve, like the proven scripts). Matters directly for real
  testnet testing.

- **F7 — a bad bot decision can no longer hang the table.** `botStep` applied
  `botDecide`'s action without checking the result; if it ever emitted an illegal
  action (future edit / unforeseen edge), the same seat would be asked forever and
  the table would hang — the worst live-testing experience. Now falls back to a
  guaranteed-legal action (check / call / all-in). Defensive; `botDecide` is legal
  today (bet/raise clamped to `[minRaiseTo, maxRaiseTo]`).

- **F8 — stale "heads-up" copy.** The hub headline and lobby intro both said
  "heads-up hold'em" although the product plays 2–9 handed — wrong expectations on a
  first-time player's very first screen. **Fixed** → "real-money hold'em (2–9
  handed)" on both.

- **F9 — added poker hotkeys (table was mouse-only).** Serious players act on
  keys, not the mouse. Added **F** fold · **C**/**Space** check-call · **R**
  bet/raise · **A** all-in · **Enter** next hand, with a discoverable hint under the
  controls. A key only fires when its control is enabled + visible, so out-of-turn
  keys are no-ops (same guard as clicks) and typing in inputs/selects is never
  hijacked. Verified headless: keys drive actions, Enter advances hands, out-of-turn
  keypresses leave the pot unchanged, 0 JS errors.

## Surfaces note

- **Payments** in the topbar is the *relay's* credits/Lightning page (shared relay
  nav), not poker — the poker money flow is the **Cashier**. Buttons are native
  `<button>`s (keyboard-focusable, Enter/Space activate), so base accessibility is
  sound; the new hotkeys add power-user keyboard play. A deeper ARIA/tab-order pass
  remains a future nicety.

- **F13 — lobby "Create a table" over-promised.** The card read "Pick stakes &
  invite a friend" but just opened the bot table — no stakes picker, no invite
  (multiplayer isn't built). Honest now: **"Practice table — Jump in vs bots, live
  multiplayer soon."**

## Reload & persistence (verified)

- **Reload mid-hand is graceful** — refreshing during a hand re-renders all seats and
  deals a fresh, playable hand with no errors (the table always starts a clean
  session; it never tries to resume a half-finished hand).
- **Session net persists at hand-end only** (`finishBetting` → `localStorage`), which
  the lobby + cashier read as the session-net bridge. A reload doesn't wipe it (the
  table never writes 0 on boot), and the lobby/cashier handle a missing value as `+0`.

## Lobby → table flow + first-time experience (verified)

- **Sit-down opens the chosen size** — every lobby table's `max` is in {2,6,9}; the
  table parses `?seats=` and validates (anything else → 6-max). Drove it: 9-max
  sit-down → `?seats=9` → table opens with 9 seats; heads-up → 2. Full tables show a
  disabled "Table full". All 6 nav links resolve.
- **The lobby is a clear first-time entry** — headline ("Real-money poker, no
  operator holding your chips"), the Sit down → Play → Settle net → Cash out flow,
  live table cards with seat-occupancy dots and open/full/in-hand badges, and a live
  session-net stat. A newcomer instantly knows to pick a table and sit.
- **Tester entry point:** `/dashboard` is the relay's *ops* dashboard with a poker
  banner on top (prominent, with Lobby/Play/Cashier CTAs). For a focused poker test,
  point testers straight at **`/lobby`** — the cleanest poker-first surface.
- **Pages degrade gracefully** — the relay-backend `fetch`es (`/api/overview`, credit
  pricing, etc.) and `/poker-engine` 404 only under a bare static server (no relay);
  the pages catch the failures and render fine — no uncaught JS errors.

## Table edge cases (verified)

- **Out-of-turn clicks are safe** — force-dispatching a click on an action button
  when it isn't your turn is a no-op (handlers guard on `toAct === 'you'`; the pot is
  unchanged). Disabled buttons don't fire anyway.
- **Result messages are correct** for both paths: contested showdown → "X wins N with
  `<category>`" (+ winning-card glow); uncontested → "X takes N — everyone folded".
  No empty/NaN/negative amounts seen.
- **Controls match poker rules** — `bCall` is always enabled on your turn (labelled
  "Check" when you owe nothing, "Call N" otherwise); `bFold` is correctly disabled in
  check spots (no folding when checking is free). The table correctly waits for the
  human ("Your move.").
- **Demo cashier math is sound** — top-ups accumulate; a session can never lose more
  than its bankroll (`net ≥ -bankroll` ⇒ `withdrawable ≥ 0`); winnings carry to the
  next session.
- **Bet controls never produce a dead click** — the slider range is pinned to the
  engine's `[minRaiseTo, maxRaiseTo]` (step BB) and the ½-pot/pot/max quick-bets clamp
  to it. Drove 38 raises (slider min, all-in, pot, half) across 14 hands: **0 dead
  clicks** — every Raise advanced the game, and the slider value was always within
  the legal range. So "I clicked Raise and nothing happened" can't occur.

## Card + hand display — what you see is what's scored (verified)

A player bets on what they think they hold, so the cards shown and the hand named
must match the evaluator exactly:

- **Cards.** `cardEl` renders rank/suit from the **same** `cardRank`/`cardSuit` the
  engine evaluates with, so the displayed card is provably the scored card (no
  divergence possible). Colour (`isRed`) is correct: hearts + diamonds red.
- **Hand readout.** The "You have: …" `handName()` and the showdown category `CAT[]`
  both index `[0..12]` (Two…Ace), matching the evaluator's rank tuple. Checked 12
  known hands incl. the tricky ones — the A-2-3-4-5 wheel reads "Straight, Five high"
  (ace low), broadway reads "Ace high", quads/full house/flush/two-pair all named
  right; all 52 indices map to a named rank. 12/12 correct.

## Side-pot payouts — proven correct (real-money critical)

The table has its **own inline `distribute()`** (the reducer pulls in sodium and
isn't browser-importable), so when players go all-in for different amounts the
browser computes the side pots itself — a divergence here would misallocate real
money. Verified it can't diverge: it aliases the reducer's exact `evaluate7`/
`compareRank` (same `hand-eval.js`), and an **8000-scenario fuzz** (4671 contested
multi-level side-pots, plus fold-wins, dead money from folders, uncalled-bet
refunds, and ties) shows `distribute()` produces **identical payouts to the tested
`reducer.settleHand` on every scenario — zero mismatches**. (Exported `settleHand`
for the comparison; off-chain suite stays 83/83.)

## Mobile

6-max and heads-up play cleanly on a 390px phone (no clipped/overlapping seats,
controls usable, 0 errors). 9-max is inherently tight on a phone but now fits after
F5. The action bar stacks full-width.

- **F10 — cashier Live mode now works relay-served (CSP untouched).** Was M2: the
  cashier loaded `ethers` from a CDN that the relay CSP (`script-src 'self'`) refuses
  when served through the relay, so Live mode only worked opened directly (file://).
  **Fixed** by vendoring `ethers.umd.min.js` into the money dir and serving it
  same-origin through the existing `/poker-engine/` whitelist; the cashier now loads
  `/poker-engine/ethers.umd.min.js`. Verified headless under the **strict relay CSP**:
  ethers loads (a CDN script would be refused), zero CSP violations, and the co-sign
  digest still byte-matches `settle.cjs` with the vendored 6.17.0. CSP stays
  `script-src 'self'` — no relaxation; the injected wallet does RPC so `connect-src`
  stays tight too.

- **F11 — self-serve testnet escrow (removes the last setup dependency).** A tester
  used to need *me* to deploy them an escrow with their address as a seat. Added a
  **"Deploy a test escrow + mint USD₮"** button to the cashier's Live mode: connect
  MetaMask on Base Sepolia and it deploys MockUSDT + PokerEscrow (you as the sole
  seat) and mints 1,000 test USD₮ — then deposit → settle → withdraw proves the whole
  on-chain rail, entirely self-served. Vendored the contract artifacts
  (`poker-artifacts.json`, served same-origin via the `/poker-engine/` whitelist).
  Verified: the vendored bytecode deploys + runs a full deposit→cooperativeClose→
  withdraw cycle on a real EVM (8 assertions, conservation held, solo seat + single
  sig works); in-browser the artifacts load + parse under the strict relay CSP, the
  button is wired, clicking without a wallet logs a clear instruction (no crash), and
  the cashier still works. Suites stay green (83 + 31 + 5).

- **F12 — solo self-test settle is now one-click.** The self-serve deploy makes a
  *solo* escrow, but the cooperative-settle section is built for multi-party
  ("0xAlice…,0xBob…" / "150,50") — a solo tester wouldn't know to type their own
  address + deposit. Now after deploy the payee auto-fills to your address and, once
  you deposit, your settle balance auto-fills to your bankroll — so the loop is
  Deposit → Sign → Submit → Withdraw with nothing to figure out. Guarded so it never
  overwrites a multi-party entry or an amount you typed. Verified: solo fills to
  100.00, "60,40" untouched, "999" not clobbered.

## Open / minor

_None outstanding from the demo-surface + on-chain-path review._ The only remaining
work is the big build below (real end-to-end on-chain play) and the operator inputs
it needs.

## Readiness for REAL human testing on testnet — the honest picture

The on-chain rail is **proven** and the gameplay UI is **solid**, but the pieces are
not yet wired into one playable real-money game:

| Test a human can run today | Status |
|---|---|
| **Gameplay UX** — play Hold'em vs bots at `/table` | ✅ ready (now with a correct net readout) |
| **On-chain money rail** — deposit → settle → withdraw real testnet USD₮ | ✅ **now fully self-serve in-browser** (F10+F11): MetaMask on Base Sepolia → "Deploy a test escrow" → deposit/settle/withdraw. No setup, no input from anyone. |
| **Full real-money game** — two humans play a hand that settles on-chain | ❌ **not wired** — see below |

**The core gap.** The demo table plays **locally vs bots** — it does **not** connect
to the relay (no real multiplayer) or to the escrow (no on-chain settlement of
actual gameplay). The cashier is a **separate manual** on-chain flow. So "two real
humans sit, play a real-money hand, and it settles on-chain" does not exist yet.
That end-to-end loop needs the **relay-multiplayer + table→reducer→escrow wiring**
(the Phase-06 / integration piece) — the betting engine, reducer, escrow, and relay
signed-log all exist and are tested individually, but nothing joins them into a
single real-money table.

## Recommended next steps (for a real human test)

1. ✅ **Done** across iterations 1–9: net display, stale badges, names, mobile 9-max,
   deposit RPC-lag, hung-table guard, heads-up copy, keyboard hotkeys, same-origin
   ethers (M2/F10), self-serve escrow deploy (F11), one-click solo settle (F12).
2. ✅ **Interactive on-chain test** — no longer needs the operator: the cashier's
   "Deploy a test escrow" button provisions everything from the tester's own wallet.
3. **The remaining frontier — real multiplayer money game.** Concrete scope:
   - **Shared table state.** Join the table to the relay's signed log so two humans
     see one game. `fra/play-on-fra.mjs` already drives the real relay's log →
     reducer; the table needs to (a) create/join a relay table, (b) post each action
     as a signed log entry, (c) render from the shared log instead of local bots.
     Needs a running relay — the **FRA management key** (live relay, operator-gated)
     or a **local relay instance** to develop against.
   - **Settle real gameplay.** On hand/session end, run `reducer.js` over the signed
     log → net balances → the cashier's existing `cooperativeClose` (co-sign) or
     `disputeClose` (committee) path. The settle digest is already on-chain-valid
     (verified), so this is wiring the reducer output into the (working) settle UI.
   - **Seat ↔ wallet binding.** Each seat's relay identity maps to its on-chain
     address (escrow participant), so the reduced balances settle to the right payees.
   - **Effort:** multi-day; needs relay access to build+verify. Everything *below*
     this line (engine, reducer, escrow, settle, signed-log) exists and is tested —
     this is integration, not new primitives.
