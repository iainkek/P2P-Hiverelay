# P2Poker escrow — runbook

Isolated hardhat subproject for the USD₮ state-channel escrow. Self-contained
(own `node_modules`, gitignored). Does **not** touch the live poker service.

## Install
```
cd packages/services/builtin/poker/money/escrow
npm install
```

## Test (local EVM, no network/keys)
```
npx hardhat test
```
Proves the **deposit / play / withdraw-net** model: deposit → cooperative close
records each seat's net → each seat `withdraw()`s its net; conservation +
missing-sig rejection; dispute/oracle close (committee attestation); a losing
seat can only pull its NET, never reclaim its full deposit; reentrancy
resistance on `withdraw()`; and the **reducer → escrow integration** (a played
session's net balances drive the real payout).

## Deploy locally (in-process node)
```
npx hardhat run scripts/deploy.cjs
```

## Deploy to a TESTNET  ← needs a funded key
1. Get a testnet RPC URL (Arbitrum Sepolia or Base Sepolia recommended — cheap,
   fast, good USD₮ tooling) and a private key **funded with testnet gas** from a
   faucet.
2. Export env (never commit these):
   ```
   export TESTNET_RPC_URL="https://<your-rpc>"
   export TESTNET_PRIVATE_KEY="0x<funded-key>"
   ```
3. Deploy (deploys MockUSDT + escrow by default; set `USDT_ADDRESS` to use a
   real test USD₮):
   ```
   npx hardhat run scripts/deploy.cjs --network testnet
   ```
   Optional env: `PARTICIPANTS`, `COMMITTEE`, `THRESHOLD`, `USDT_ADDRESS`,
   `ESCROW_LABEL`.
4. The script prints the escrow + USD₮ addresses + escrowId. Then each
   participant `approve()`+`deposit()` their bankroll; play off-chain; settle
   the net via `cooperativeClose` or `disputeClose` (see `settle.cjs` for digest/
   balance construction); finally each seat calls `withdraw()` to pull its net.
   There is no deposit-refund path — your bankroll is at risk during play and you
   only ever take out your settled net.

## What this needs from the operator (the only remaining gate)
- A **funded testnet private key** + **RPC URL**. Everything else is built and
  green locally. Provide those two and the deploy above broadcasts for real.

## Where the relay (FRA) fits
The escrow is **on-chain** and chain-only — the relay never holds funds. FRA
(`milkyb-hiverelay-fra`, a LIVE relay → use as a client endpoint, do not
redeploy) is the **signed-log substrate** the hand plays on, and (next, HR-side
Phase 03) the **attestation service** that signs the reducer's `sessionHash` so
`disputeClose` can settle the grief path. The committee addresses passed to the
escrow are those relay attestor keys (as Ethereum addresses for `ecrecover`, or
a BLS aggregate later).
```
off-chain:  HiveRelay signed log  ──reduce()──▶ {sessionHash, balances}
                                                   │
on-chain:   PokerEscrow (USD₮)  ◀── cooperativeClose (players sign)   ─┐ settle net
                                ◀── disputeClose   (committee attests) ─┘
                                ──▶ withdraw()  (each seat pulls its net)
```
```
