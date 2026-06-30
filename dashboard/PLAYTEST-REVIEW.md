# P2Poker — playtest review (player's perspective)

A deep review of every user flow from the perspective of a real human sitting down
to play and to test the real-money rail on testnet. Living doc — updated as the
review loop runs.

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

## Mobile

6-max and heads-up play cleanly on a 390px phone (no clipped/overlapping seats,
controls usable, 0 errors). 9-max is inherently tight on a phone but now fits after
F5. The action bar stacks full-width.

## Open / minor

- **M2 — cashier Live mode + relay CSP.** The cashier loads `ethers` from a CDN,
  which the dashboard CSP (`script-src 'self' 'unsafe-inline'`) blocks when
  **relay-served**. Live mode works opened directly (file://) but not through the
  relay. Fix: self-host ethers same-origin (like `/poker-engine`) + use the injected
  wallet for RPC so connect-src stays tight.

## Readiness for REAL human testing on testnet — the honest picture

The on-chain rail is **proven** and the gameplay UI is **solid**, but the pieces are
not yet wired into one playable real-money game:

| Test a human can run today | Status |
|---|---|
| **Gameplay UX** — play Hold'em vs bots at `/table` | ✅ ready (now with a correct net readout) |
| **On-chain money rail** — deposit → settle → withdraw real testnet USD₮ | ✅ proven via scripts; in-browser needs (a) their wallet as an escrow seat, (b) ethers loading (M2), (c) MetaMask on Base Sepolia |
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

1. **Done:** net display, stale badges, name.
2. **Deploy the user an interactive escrow** — a fresh PokerEscrow with *their*
   wallet as a seat + minted MockUSDT + a pre-filled cashier config, so they can
   click a real deposit→settle→withdraw in the browser. (Needs their address.)
3. **Fix M2** (self-host ethers) so the cashier Live mode works relay-served.
4. **The big one:** wire a real table to the escrow + relay so a played hand reduces
   to a settlement that's co-signed/attested on-chain — the bridge from "demo" to
   "real human poker."
