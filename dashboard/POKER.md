# P2Poker — dashboard suite

The player-facing front-end for real-money (testnet USD₮) heads-up poker on
HiveRelay. Four static pages, served by the relay's dashboard router, that take a
player from "find a table" through "play" to "cash out" — with the pot enforced by
an on-chain escrow, never an operator.

## Surfaces & routes

| Route | File | What it is |
|---|---|---|
| `/dashboard` | `index.html` | Relay dashboard. Carries a **P2Poker hub tile** (top of page) linking to Lobby / Play / Cashier. |
| `/lobby` | `lobby.html` | Table browser — a demo stakes ladder (Satoshi Micro → High Roller) plus any **live** tables from `GET /api/poker/tables`. Open/full/in-hand badges, seat dots, your session net, create-table. |
| `/table` | `table.html` | Playable **No-Limit Hold'em, 2–9 seats** (`?seats=2\|6\|9` or the selector) vs bots. Full betting (fold/check/call/bet/raise/all-in + quick-bet ½·pot·max), street-by-street board, side pots, re-buy, hand-strength readout, winning-card glow, pot-ship. Imports the **real** engine over `/poker-engine`. |
| `/cashier` | `cashier.html` | The USD₮ escrow: **deposit → settle net → withdraw**, a lifecycle stepper, win/loss payoff banner, and (live) the **cooperative co-sign** settlement flow. |

Routing lives in `packages/core/core/relay-node/api-dashboard-routes.js`
(`FULL_DASHBOARD_ROUTES`) and is unit-tested in
`test/unit/api-dashboard-routes.test.js`. Pages are served verbatim by
`api.js`'s `_serveDashboard`. To view them locally, run the relay (the **Relay
Node** entry in `.claude/launch.json`, port 9100) and open `/lobby` — note the
*simple* UI mode redirects full tabs to `/dashboard`, so use the non-simple node.

## Demo vs Live

Every money page runs in two modes:

- **Demo** (default): the whole lifecycle is **simulated locally** — no chain, no
  wallet. Lets the flow be demonstrated with nothing deployed. The table is
  always demo (the real game runs server-side; see below).
- **Live**: the cashier uses **ethers** (CDN) + the escrow ABI against a deployed
  `PokerEscrow` + USD₮ token you configure (escrow address / token / RPC), driven
  by an injected wallet. Reads on-chain state, runs approve+deposit / withdraw,
  and the cooperative co-sign.

## The player journey

```
 Lobby (sit down)
   └─▶ Table (play hands off-chain)   ──writes net/hands/stack──▶ localStorage
         └─▶ Cashier  (deposit bankroll · settle the NET · withdraw)
               └─ reads the table session → shows it as a bridge
```

The three pages cohere via `localStorage` keys `p2poker.{net,hands,stack}`: the
table writes them on every hand end; the lobby shows "Your Session Net" and the
cashier shows a table-session bridge.

## How the front-end maps to the backend

- **Cashier ↔ on-chain money.** The cashier's live mode mirrors the tested Node
  client: `escrow/client.cjs` (`EscrowClient`), `escrow/settle.cjs` (digests),
  and `escrow/contracts/PokerEscrow.sol`. The cooperative-close digest computed
  in-browser — `keccak256(abi.encode(bytes32 escrowId, address[] payees,
  uint256[] balances))` — is **byte-identical** to the contract and `settle.cjs`,
  so UI-produced EIP-191 signatures verify on-chain.
- **Table ↔ the real engine (no duplicate).** `table.html` **imports** the actual
  `money/betting.js` (its interactive API — `createHand`/`legalActions`/
  `applyAction`/`view`) and `money/hand-eval.js`, served by the relay at
  `/poker-engine/<file>.js` (whitelisted, read-only; `api.js`'s `_servePokerEngine`).
  So the demo table runs the **same tested betting engine** the relay uses — not a
  reimplementation — for any table size 2–9. The only inlined piece is the
  showdown side-pot split (mirrors `reducer.js`'s `settleHand`; `reducer.js` itself
  isn't browser-importable because it pulls in `sodium`). It is still a local
  demo: the authoritative game runs server-side over the HiveRelay signed log.
- **Settlement paths.** All three exist end-to-end: cooperative (players co-sign,
  drivable from the cashier UI), committee dispute (`disputeClose` + `attest.cjs`),
  and arbitration/cheat (`arbitration-bridge.js`). See `money/README.md`.

## Cooperative co-sign (cashier, live)

The happy-path settlement, drivable from the UI:

1. **Agreed result** — enter the session's final balances (deposit ± net) per
   payee. In production these come from `reduce(session)`.
2. **Sign your share** — your wallet signs the cooperative-close digest (EIP-191).
   Every seat signs and shares its signature.
3. **Submit on-chain** — anyone pastes the collected signatures and calls
   `cooperativeClose`; each seat then `withdraw()`s its net.

## Verification

Every page and flow is exercised with headless Chrome (puppeteer-core against the
system browser, pages loaded via `file://`): lifecycle math, disabled-state gating,
the deposit→settle→withdraw + co-sign paths, hand-naming, the table-session
bridge, and a 390px mobile sweep. The load-bearing check is that the in-browser
cooperative digest equals the contract's.

## Status

Feature-complete in demo; live mode is wired and ready against a deployed escrow.
Go-live still needs operator credentials (a funded testnet key + RPC, and the FRA
relay key) — the same two gates as the backend money stack. External audit of
`PokerEscrow.sol` + the attestation scheme remains the prerequisite before real
value.
