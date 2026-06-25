# Phase 01 — RESEARCH

Findings that drive [DECISION.md](DECISION.md). Sources are linked inline.

## 1. What WDK actually exposes (the gating question)

WDK is a **modular, self-custodial, stateless wallet SDK** (keys never leave the
client; BIP-39; Node → React Native → embedded → **Bare**). Module list
([all-modules](https://docs.wdk.tether.io/sdk/all-modules)):

| Module | Use |
|---|---|
| `@tetherto/wdk-wallet-btc` | Bitcoin SegWit (BIP-39/44) |
| `@tetherto/wdk-wallet-evm` | EVM tx send (any EVM chain) |
| `@tetherto/wdk-wallet-evm-erc4337` | **ERC-4337 account abstraction** (smart accounts) |
| `@tetherto/wdk-wallet-evm-7702-gasless` | **EIP-7702 gasless** AA |
| `@tetherto/wdk-wallet-solana` | Solana |
| `@tetherto/wdk-wallet-ton` / `-ton-gasless` | TON (+ gasless) |
| `@tetherto/wdk-wallet-tron` / `-tron-gasfree` | TRON (+ gas-free) |
| `@tetherto/wdk-wallet-spark` | **Spark / Lightning** BTC L2 |
| `@tetherto/wdk-core` | orchestrator |

**Key reads:**
- WDK is a **wallet/signer/broadcaster + account abstraction**, not a
  smart-contract *framework*. A contract call is just a transaction with
  calldata, so `wdk-wallet-evm` *can* send one — but you bring the contract +
  ABI encoding (ethers/viem) and use WDK as the signer/broadcaster. There is a
  ["Protocol Integration"](https://docs.wdk.tether.io/sdk/core-module/usage/protocol-integration)
  surface; **confirm hands-on** that `wdk-wallet-evm` accepts arbitrary
  calldata + value (the one capability the whole EVM path rests on).
- It exposes **Safe Accounts (Safe-protocol multisig)** under ERC-4337
  ([wdk-wallet-evm-erc-4337](https://github.com/tetherto/wdk-wallet-evm-erc-4337)) —
  i.e. multisig smart accounts are first-class on EVM.
- **Gasless** modules (EIP-7702 EVM, TON, TRON) matter for UX: players
  shouldn't need native gas tokens to play.
- Backend dependency: `wdk-core` orchestrates; docs don't pin a mandatory
  Tether-hosted indexer, but WDK's broader docs list an Indexer/Failover
  Provider — **treat chain-data/broadcast as a possible hosted dependency** to
  verify (liveness risk, §4 of PROJECT risks).

**Conclusion:** WDK is strongest on **EVM** (standard + AA + Safe multisig +
contract calls + gasless). That is where building an escrow *through* WDK (not
around it) is realistic.

## 2. Spark / Lightning (the BTC path)

Spark ([Lightspark](https://www.lightspark.com/news/spark/introducing-spark)) is
a statechain-based Bitcoin L2: **2-of-2 multisig** (user + operator set),
**unilateral exit**, instant self-custodial BTC/token transfer, and
**HTLCs / atomic swaps** for Lightning
([HTLC](https://www.spark.money/glossary/htlc)).

- ✅ Great as a **fast deposit/cashout + Lightning rail**, and HTLCs give a
  real **conditional-payment** primitive for future per-hand fast settlement.
- ❌ Its native model is **2-of-2 (user+operator)**, *not* an arbitrary n-of-n
  player pot with oracle release. So Spark is **a rail, not the v1 pot**.

## 3. Escrow patterns (confirming the design)

Standard, well-trodden patterns ([Chainlink multisig](https://chain.link/article/multi-signature-wallet),
[Solana Anchor escrow](https://medium.com/@paullysmith.sol/building-a-trustless-escrow-contract-on-solana-with-anchor-4e03c4d2ccc0)):
- **n-of-(n+arbitrator) multisig / program vault**: funds in code-controlled
  escrow; cooperative release when all sign; arbitrator path on dispute.
- **Oracle release**: contract pays out on a *verified off-chain attestation* —
  exactly our relay-quorum verdict over the canonical outcome.
- **Timeout/unilateral exit** with a challenge period so no one can freeze funds.

## 4. The reframe that de-risks everything: this is a STATE CHANNEL

Poker isn't a per-hand on-chain settlement problem. The right model:

> Escrow contract = the channel's on-chain anchor holding each player's
> **session bankroll**. Play happens **off-chain on the HiveRelay signed log**
> (the channel's state + data-availability). Settle **net, per session**:
> cooperative close (all sign final balances) or dispute close (contract
> verifies the relay-quorum attestation of the canonical outcome). A
> challenge-period unilateral exit guarantees liveness.

This maps the milestone onto **application-specific state channels** — a
studied, understood pattern — and slots the two prongs in perfectly:
- **HiveRelay** = the channel's data-availability + watchtower + **oracle**
  (attestation) + objective clock. (PROJECT "neutral witness".)
- **P2Poker + WDK** = open/fund/close the channel; off-chain play; signing.

It also answers **per-hand vs per-session**: **per-session** (many hands off-
chain, one net on-chain settlement) — per-hand on-chain is too slow/expensive.

## 5. Open verification items (carry into the spike build / NOTES.md)
1. Confirm `wdk-wallet-evm` sends arbitrary contract calldata + value (deploy +
   call an escrow contract). *Decisive — verify hands-on against the SDK.*
2. Confirm whether WDK requires a hosted indexer/RPC (liveness/centralization).
3. Confirm gasless (EIP-7702) works for the deposit + close calls (UX).
4. On-chain verification cost of the relay-quorum **attestation signature**
   (which scheme — BLS aggregate vs k Ed25519/secp256k1 sigs) — drives Phase 03.
