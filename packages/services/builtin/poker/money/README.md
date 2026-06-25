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
                  └────────────── USD₮ pays out ────┘   (no operator can steal/freeze)
```

The escrow is an **application-specific state channel**: deposit a session
bankroll on-chain, play off-chain on the signed log, settle net per session
(cooperatively, or via the relay-quorum attestation oracle on grief).

## What's built (all green, isolated)

| Module | Phase | What | Tests |
|---|---|---|---|
| `hand-eval.js` + `reducer.js` | 02 | deterministic settlement (winners from revealed cards, side-pots, conservation, `sessionHash`) | 10/10 |
| `escrow/contracts/PokerEscrow.sol` | 08 | USD₮ state-channel escrow (deposit / cooperative / dispute / exit) | 6/6 |
| `escrow/settle.cjs` | 10/11 | reducer net-balances → on-chain close calldata | (incl. below) |
| `escrow/attest.cjs` | 03 | relay verdict attestation (grief-path oracle) | 3/3 |
| `escrow/wallet/wdk-signer.cjs` | 07 | Tether **WDK** player wallet (escrow-compatible sigs) | 2/2 |
| `fra/play-on-fra.mjs` | — | drive the REAL relay's signed log → reducer | ready |

Reducer→escrow integration (a played session drives the actual USD₮ payout,
cooperative **and** dispute) is proven on a local EVM. Run the on-chain suite:
```
cd escrow && npm install && npx hardhat test     # 13 passing
```
Run the off-chain reducer suite:
```
npx brittle test/unit/poker-reducer.test.js      # 10 passing  (from repo root)
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

## Not yet built (next, if wanted)
- **Phase 09 betting engine** — turns raw player actions (blinds/bet/raise/fold)
  into the normalized hand records the reducer consumes (the harness fakes this
  today). Needed for full live gameplay; not needed to prove testnet settlement.
- Phase 04/05/06 HR refinements (arbitration verdict wiring, objective
  timeouts, watchtower seeding of settlement-critical data).
- Production hardening + external audit of `PokerEscrow.sol` and the attestation
  signature scheme (the ADR notes BLS-aggregate as the scale-up).
