# Phase 01 — DECISION (ADR)

**Status:** Proposed (spike output; ratify before Phase 02/07 build)
**Context:** [PLAN.md](PLAN.md) · [RESEARCH.md](RESEARCH.md)

## Decision

**v1 escrow = an application-specific STATE CHANNEL anchored by an EVM escrow
contract holding USD₮, with WDK as the wallet/signer.** Players deposit a
**session bankroll**; hands play **off-chain on the HiveRelay signed log**;
settlement is **net, per session**, with three closes:

1. **Cooperative close** — all participants sign the final balance vector →
   contract pays out. Fast, cheap, no relay involvement.
2. **Dispute close** — contract verifies the **HiveRelay relay-quorum
   attestation** (Phase 03) over the canonical outcome (Phase 02 `sessionHash`)
   and pays the verdict; slashes the griefer's bond.
3. **Timeout / unilateral exit** — challenge-period exit so funds can never be
   frozen by a non-cooperative party or an offline relay set.

**Settlement granularity: PER SESSION**, not per hand (gas/latency).

## Mechanism decision matrix

| Mechanism | Trustless pot? | Latency / cost | WDK support | Grief→oracle release | v1 verdict |
|---|---|---|---|---|---|
| **EVM escrow contract (USD₮, L2)** | ✅ contract vault | low on L2 / cheap | ✅ **strong** (evm + 4337 + 7702-gasless + Safe) | ✅ contract verifies attestation | **CHOSEN v1** |
| Solana PDA escrow program (USD₮) | ✅ program vault | very low / very cheap | ✅ wallet-solana (build program) | ✅ program verifies attestation | **v1.1 alt** (cheapest) |
| BTC taproot / MuSig2 pot | ✅ multisig | high fees, slow | ⚠️ btc module is SegWit-only → build *around* WDK | hard (no rich script verify of attestation) | defer |
| Lightning / **Spark** conditional | partial (2-of-2) | instant / cheap | ✅ wallet-spark | HTLC, not arbitrary-n oracle | **rail only** (deposit/cashout + future fast layer) |

## Rationale

- **USD₮, not BTC, as the chip.** Real-money poker needs a stable unit; BTC
  volatility mid-session is unacceptable. USD₮ is native on EVM/L2, Solana, Tron.
- **EVM because WDK is strongest there.** `wdk-wallet-evm` (+ `erc4337` /
  `7702-gasless` / Safe) lets us build/fund/call the escrow *through* WDK, with
  gasless UX — the others would mean building *around* the wallet.
- **L2 (Arbitrum/Base-class), not L1.** Per-session settlement is still on-chain;
  L1 gas is prohibitive; an L2 keeps closes cheap while USD₮ liquidity is fine.
- **State-channel framing de-risks it.** Deposit on-chain, play off-chain,
  settle net, dispute via on-chain verification of signed state is a *known*
  pattern. HiveRelay supplies the channel's data-availability + watchtower +
  oracle (attestation) + objective clock — exactly the HR-side roadmap (02–06).
- **Spark stays a rail.** Its HTLC/atomic-swap + instant Lightning is ideal for
  deposit/cashout and a *future* per-hand fast-settlement layer, but its 2-of-2
  statechain isn't an arbitrary-n pot with oracle release, so it's not the v1 pot.

## Multi-asset path (post-v1)

1. **Solana PDA escrow** (USD₮) — cheapest/fastest; same attestation oracle.
2. **Spark/Lightning** deposit + cashout rail; explore HTLC per-hand fast layer.
3. **BTC MuSig2** pots only if a BTC-native audience demands it (high effort).

## Consequences for downstream phases

- **02 (reducer):** must emit a `sessionHash` (net balances) the contract's
  dispute-close verifies — not just per-hand results.
- **03 (attestation):** the **on-chain-verifiable signature scheme is now a hard
  constraint** — prefer a scheme cheap to verify in the EVM (BLS aggregate, or a
  small k of secp256k1 sigs the contract `ecrecover`s). Decide in 03.
- **07 (WDK):** integrate `wdk-wallet-evm` (+ gasless); confirm arbitrary
  contract-call capability (RESEARCH §5.1).
- **08 (escrow):** the contract from this spike becomes the funded escrow; the
  `escrowProof` is a verifiable deposit reference.
- **05 (timeouts):** the contract's challenge-period must align with the relay's
  objective settlement clock.

## What we deliberately are NOT deciding now

- Final L2 choice (Arbitrum vs Base vs Polygon) — pick during 07/08 on fees +
  USD₮ liquidity + WDK testing.
- The attestation signature scheme — Phase 03 (but constrained to on-chain-cheap).
- Per-hand fast settlement (Spark/HTLC) — explicitly post-v1.

## Open question resolved
**Per-hand vs per-session settlement → PER-SESSION** (state channel). Per-hand
on-chain settlement is rejected on latency/cost grounds.
