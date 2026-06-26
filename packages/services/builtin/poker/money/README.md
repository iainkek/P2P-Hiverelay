# P2Poker money layer — real-money settlement (testnet)

Isolated, additive modules that add **real-money (testnet USD₮) settlement** to
P2Poker. **None of this touches the live poker service** — it's all new code
under `money/`, built on a feature branch. Architecture per
`.planning/` (GSD plan + Phase 01 ADR).

## The system

```
 off-chain (HiveRelay signed log)                on-chain (EVM testnet, USD₮)
 ─────────────────────────────────               ────────────────────────────
 players play a hand  ──signed entries──▶  FRA relay (card-blind signed log)
                                                   │  read log
                                                   ▼
                              reduce(session) ──▶ { sessionHash, balances }
                                                   │
                  ┌────────────────────────────────┼─────────────────────────┐
                  ▼ (happy path)                    ▼ (grief path)
       players co-sign final balances    relay COMMITTEE attests sessionHash
                  │                                 │  (secp256k1 / ecrecover)
                  ▼                                 ▼
         PokerEscrow.cooperativeClose      PokerEscrow.disputeClose
                  └────── settle NET balances ──────┘   (no operator can steal/freeze)
                                  │
                                  ▼
                    each seat withdraw()s its NET   (pull-based; no full-deposit escape)
```

The escrow is an **application-specific state channel** that works like a normal
poker service: deposit a session bankroll on-chain, play off-chain on the signed
log, settle the NET per session (cooperatively, or via the relay-quorum
attestation oracle on grief), then each seat **pulls its own net** via
`withdraw()`. There is no unilateral deposit-refund — your bankroll is at risk
during play and you only ever take out your settled net (you cannot reclaim a
full deposit to escape a loss). If you never withdraw, you get nothing.

## What's built (all green, isolated)

| Module | Phase | What | Tests |
|---|---|---|---|
| `hand-eval.js` + `reducer.js` | 02 | deterministic settlement (winners from revealed cards, side-pots, conservation, invalid-deal rejection, `sessionHash`) | 12 |
| `betting.js` | 09 | No-Limit Hold'em betting engine — **heads-up + multiway** (blinds, turn order, min-raise, all-in incl. incomplete-raise rule, street progression) → contributions/folded | 16 |
| `arbitration-bridge.js` | 04 | cheating verdict → cheater forfeits → reducer re-settles to the honest player | 4 |
| `timeout.js` | 05 | objective settlement deadlines from relay-signed timestamps (stall → overdue) | 4 |
| `escrow/contracts/PokerEscrow.sol` | 08 | USD₮ state-channel escrow — **deposit / settle-net / withdraw** (cooperative + committee-dispute; no deposit-refund escape), **reentrancy-hardened (CEI + guard)** | 18 |
| `escrow/settle.cjs` | 10/11 | reducer net-balances → on-chain close calldata | (in escrow suite) |
| `escrow/attest.cjs` | 03 | relay verdict attestation (grief-path oracle) | (in escrow suite) |
| `escrow/wallet/wdk-signer.cjs` | 07 | Tether **WDK** player wallet (escrow-compatible sigs) | (in escrow suite) |
| `escrow/scripts/full-demo.cjs` | — | end-to-end capstone: betting → reduce → settle in USD₮ (both close paths) | runnable |
| `fra/play-on-fra.mjs` | — | drive the REAL relay's signed log → reducer | ready (needs FRA key) |

**All three settlement paths exist:** cooperative (players co-sign), stall
(relay attestation), and cheat (arbitration → forfeit). Run the suites:
```
npx brittle test/unit/poker-*.test.js              # 72 passing  (off-chain, from repo root)
cd escrow && npm install && npx hardhat test       # 18 passing  (on-chain, local EVM)
npx hardhat run scripts/full-demo.cjs              # the end-to-end capstone demo
```

## Go live — the only two remaining steps (both operator credentials)

Everything above is built and tested. To make it actually live needs two
operator-provided credentials (not code):

**1. On-chain USD₮ broadcast** — a funded testnet key + RPC:
```
cd escrow
export TESTNET_RPC_URL="https://<arbitrum-or-base-sepolia-rpc>"
export TESTNET_PRIVATE_KEY="0x<funded-key>"      # gas from a faucet
npx hardhat run scripts/deploy.cjs --network testnet
# → deploys MockUSDT + PokerEscrow; then deposit → cooperative/dispute close on-chain
```

**2. FRA signed-log run** — the relay management key (FRA gates table creation
with `Authorization: Bearer`):
```
FRA_API_KEY="<relay management key>" \
  node packages/services/builtin/poker/money/fra/play-on-fra.mjs
# → creates an ephemeral test table on FRA, posts a signed hand, reduces it
```

## Status: feature-complete in isolation

Every cleanly-isolatable module is built, tested, and demonstrated (90 tests +
the capstone demo). What remains genuinely needs the operator or the live relay:

- **Go-live (operator credentials)** — the two steps above: a funded testnet key
  for the on-chain broadcast, and/or the FRA management key for the signed-log
  run. The code is wired and ready for both.
- **Phase 06 — watchtower** (relay seeding of settlement-critical data so a hand
  settles even after a peer goes offline). Not isolatable: it's a relay
  integration that needs the running relay + the seeding machinery, so it's
  built against FRA (with the FRA key), not as a standalone module.
- **External audit** of `PokerEscrow.sol` + the attestation signature scheme
  (the ADR notes BLS-aggregate as the scale-up) before handling real value.
