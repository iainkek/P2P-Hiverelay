# PROJECT — Real-money P2Poker: payments, escrow & settlement

> Milestone planning for adding real-money play to P2Poker. Authored in GSD
> format. The wallet choice (Tether **WDK**) and the legal/licensing track are
> settled out of band; this milestone is the **technical** delivery, split
> deliberately across the **HiveRelay (HR)** side and the **P2Poker (Pear
> client)** side.

## Where we are today (grounded in the code)

`packages/services/builtin/poker/` already provides a working, card-blind poker
substrate — but **zero value handling**:

- **Substrate**: per-table append-only **signed log** (`signed-log.js`). The
  relay only checks signature, per-writer monotonic `seq`, ±60s clock skew,
  size, and table id. It never reads payloads (`payload` is opaque).
- **Fairness**: per-hand randomness is **VRF-anchored** (`hand-seed.js`); the
  client layers **mental poker** on top (commutative encrypt-shuffle +
  **Chaum-Pedersen** share proofs in `crypto/chaum-pedersen.js`).
- **Liveness/grief**: **pre-committed reveal shares** (threshold) + the
  **arbitration service** (`builtin/arbitration-service.js`: `missing-share`,
  `invalid-share`, `refused-reveal`) with operator voting/slashing.
- **Identity**: persistent ed25519 pubkeys; a table is an allowlist of writer
  pubkeys.
- **Money**: the `stake` / `settle` / `escrowProof` entries in the poker README
  are **illustrative opaque payloads only**. There is **no pot, no balance, no
  escrow, no payout, no bet validation** anywhere.

So fairness and ordering are solved; **value custody and settlement are
entirely unbuilt** — that is this milestone.

## North star

Real-money poker where:

1. **HR never holds value and never enforces game rules.** It stays card-blind
   and non-custodial — the neutral, always-on, tamper-evident *witness*.
2. **Players self-custody** their funds via **WDK** (USD₮ / BTC / Lightning,
   Bare-native — same runtime as Pear).
3. **The pot is escrowed trustlessly** and settled either cooperatively (fast
   path) or via an **objective, disputable verdict** derived from the immutable
   signed log (grief path) — no operator can steal or freeze funds.

## Architecture principle — the two-pronged split

The single rule that decides which side owns what:

> **HR = neutral witness (no value, no rules). P2Poker = value + rules.**

| Concern | Side | Why |
|---|---|---|
| Signed-log substrate, ordering, clock | **HR** | Already there; neutral, always-on |
| Canonical hand-outcome reducer (log → winner/stacks) | **HR**¹ | One deterministic source of truth both sides recompute |
| Verdict **attestation** (signed oracle of the outcome) | **HR** | Only the neutral witness can be the oracle the escrow trusts |
| Arbitration + slashing references | **HR** | Extends existing service; committee is relay-side |
| Objective settlement timeouts | **HR** | Relay timestamps make "missed window" non-subjective |
| Watchtower availability of settlement-critical data | **HR** | HiveRelay's seeding role keeps grief-path data alive |
| **Wallet** (keys, balances, deposit/withdraw) | **P2Poker** | Self-custody lives with the player (WDK) |
| **Escrow** construction + funding | **P2Poker** | Players' keys + funds build/fund the pot |
| **Betting engine** / pot math | **P2Poker** | Game rules are client-side; HR stays card-blind |
| **Settlement** (co-sign payout / dispute-driven release) | **P2Poker** | Players move their own value |

¹ The reducer is a pure library usable on both sides; HR *runs* it to attest,
the client *runs* it to verify before releasing funds. Neither side trusts the
other's claim — both recompute from the same immutable log.

## Money & escrow model (direction — confirmed in Phase 01)

- Per-hand (or per-session) **escrow = n-of-n multisig among seated players +
  the arbitration committee as a threshold fallback**, funded via WDK.
- **Cooperative path**: at showdown all players co-sign the payout for the
  agreed final stacks → broadcast via WDK. Fast, HR-free.
- **Grief path**: if a player won't co-sign / disconnects past the objective
  timeout, the **arbitration committee** computes the canonical verdict from the
  signed log, HR **attests** it, and the committee threshold co-signs the
  verdict-determined payout (with bond slashing). HR's attestation is the
  **oracle** that makes this objective.
- Exact mechanism per asset (BTC taproot/MuSig2 vs EVM/Solana escrow contract
  vs Lightning/Spark conditional) is the **Phase 01 decision**.

## Explicitly out of scope (here)

- Licensing / KYC / geofencing / responsible-gambling policy — **resolved
  separately**; this milestone leaves typed hooks where those gates attach but
  does not implement the policy.
- The existing fairness/mental-poker engine internals (already built).
- Fast-chip layers (**Cashu ecash** — see `incentive/payment/cashu.js` — or
  **Pear Credit**) are noted as *optional future* speed/UX layers; both
  reintroduce an issuer/trust point and are not on the trustless critical path.

## Top risks (carried into the roadmap)

1. **Escrow mechanism is per-asset and not uniform** → Phase 01 spike gates all.
2. **Abort/grief economics** — make quitting strictly unprofitable (bond ≥ max
   swing) without punishing honest disconnects → Phases 05/11.
3. **Constant-time crypto in pure JS** — the README flags Chaum-Pedersen is
   best-effort CT, not native-grade → Phase 12 review / possible native module.
4. **WDK backend dependency** (Indexer / Failover Provider) is a liveness/
   centralization edge that cuts against "unstoppable" → evaluate in 01/12.
5. **Collusion / multi-accounting** — out of crypto scope but must be designed
   around (table caps, reputation) → noted, not solved here.

## Definition of done (milestone)

A full real-money hand completes on testnet end-to-end: players fund escrow via
WDK, play a provably-fair hand, and the pot reaches the winner on **both** the
cooperative path and the griefed path (verdict-attested, committee-cosigned),
with no party able to steal or freeze funds, validated under adversarial tests.
