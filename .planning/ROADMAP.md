# ROADMAP — Real-money P2Poker (M1)

Milestone **M1**: take P2Poker from card-blind-but-play-money to real-money,
with WDK wallets + trustless pot escrow + log-derived settlement. See
[PROJECT.md](PROJECT.md) for the architecture and the HR / P2Poker split rule.

**Legend:** `[HR]` runs on the HiveRelay relay side · `[P2P]` runs in the
P2Poker Pear client · `[LIB]` shared pure library (runs on both) · `[X]`
cross-cutting.

**Critical path:** `01 → 02 → {03,04,09} → {10,11} → 12`. WDK wallet (07) can
start in parallel after 01; escrow (08) needs 01+07.

```
                01 escrow+settlement spike  ── gates everything
                         │
            ┌────────────┼─────────────────────────────┐
            ▼            ▼                              ▼
   02 outcome reducer   07 WDK wallet            (research feeds all)
       [LIB]               [P2P]
        │                   │
   ┌────┴────┐              ▼
   ▼         ▼          08 escrow build+fund
 03 attest  04 arb-      [P2P]
 [HR]       verdicts        │
   │        [HR]      ┌─────┴─────┐
 05 timeouts [HR]     ▼           ▼
 06 watchtower[HR]   09 betting  10 cooperative
                     engine[P2P]  settlement[P2P]
                         └─────┬──────┘
                               ▼
                      11 dispute settlement [P2P]
                               ▼
                      12 e2e testnet + security [X]
```

---

## Phase 01 — Escrow & settlement mechanism spike  `[X]` `decision`
**Goal:** pick the escrow + settlement mechanism(s) and freeze the interfaces
the rest of the milestone builds against. **Gates everything.**
- Evaluate per asset: BTC taproot/**MuSig2** multisig, EVM/Solana **escrow
  contract**, **Lightning/Spark** conditional settlement; against WDK's exposed
  surface (does WDK give multisig/HTLC/contract calls, or only send/receive?).
- Define the **escrow descriptor** format (who signs, threshold, fallback
  committee, amounts) carried in the `stake` entry, and the **verdict-
  attestation interface** the escrow consumes to release on the grief path.
- Prototype the *thinnest* viable happy-path release on one asset on testnet.
**Success:** an ADR picking mechanism-per-asset; a written escrow+attestation
protocol spec; frozen interface stubs (`EscrowDescriptor`, `Verdict`,
`Attestation`); a working testnet co-signed release of a 2-party pot.
**Out:** production hardening, grief path (just prove the happy release).

## Phase 02 — Canonical hand-outcome reducer  `[LIB]`
**Goal:** a pure, deterministic function `reduce(signedLog) → { winner, finalStacks, potDistribution, handHash }` that both HR (to attest) and the client (to verify) compute **identically**.
- Deterministic replay of stake/bet/reveal/showdown entries → canonical result.
- Byte-exact, runtime-portable (Node + Bare); fuzz/property tested for
  determinism; defines the `handHash` that attestations and escrow sign over.
**Depends on:** 01 (entry/escrow shapes). **Success:** same log → same
`handHash` across 1k randomized hands on two runtimes; rejects malformed/illegal
logs with typed reasons.

## Phase 03 — Verdict attestation service  `[HR]`
**Goal:** HR (single relay, then quorum) signs the reducer's outcome +
escrow reference → an **oracle attestation** the escrow trusts on the grief path.
- Reuses the relay signing identity; quorum/threshold attestation so no single
  relay is the oracle; replay/equivocation guards.
**Depends on:** 02. **Success:** a verifiable multi-relay attestation over a
`handHash` that the Phase-01 escrow accepts; a forged/single-relay attestation
is rejected by the threshold check.

## Phase 04 — Settlement-aware arbitration & slashing references  `[HR]`
**Goal:** extend `arbitration-service.js` so dispute verdicts are **escrow-
consumable**: who to pay, whose bond to slash, tied to the reducer + attestation.
**Depends on:** 02, 03. **Success:** each existing dispute type
(`missing-share`/`invalid-share`/`refused-reveal`) yields a signed verdict the
escrow release path can act on; slashing target is unambiguous and evidenced.

## Phase 05 — Objective settlement clock & timeouts  `[HR]`
**Goal:** anchor settlement deadlines to relay-signed timestamps so "missed the
showdown / co-sign window" is objective and disputable (no he-said-she-said).
**Depends on:** 01. **Success:** a signed-log proof can establish a deadline was
passed; honest-but-slow players get a fair grace window (config, not magic).

## Phase 06 — Settlement-critical availability (watchtower)  `[HR]`
**Goal:** ensure reveal-shares, escrow descriptors, and attestations are
**seeded/persisted by relays** so settlement survives peer churn.
- Builds on HiveRelay seeding + the custody/lifetime-hint machinery.
**Depends on:** 03. **Success:** a hand settles correctly after the original
author of the reveal shares goes fully offline pre-showdown.

## Phase 07 — WDK wallet integration  `[P2P]`
**Goal:** embed **WDK** in the Pear poker client (Bare-native): key management,
balances, deposit/withdraw for USD₮ / BTC / Lightning.
- Establish the WDK abstraction the escrow/settlement code calls (so the asset/
  chain choice from 01 is swappable).
**Depends on:** 01 (asset choice). **Success:** a player funds and withdraws a
testnet balance from inside the app; private keys never leave the client.

## Phase 08 — Escrow construction & funding  `[P2P]`
**Goal:** build the per-hand/session escrow (mechanism from 01) from seated
player keys + committee, fund it via WDK, and emit a verifiable `escrowProof`
into the `stake` entry; verify peers' proofs before the deal starts.
**Depends on:** 01, 07. **Success:** N players co-create + fund an escrow; the
table refuses to deal until every seat's `escrowProof` verifies on-chain/-ledger.

## Phase 09 — Betting engine & pot accounting  `[P2P]`
**Goal:** chips/stacks/pot computed over the signed log with legal-move + bet-
sizing validation, **deterministically matching the Phase-02 reducer**.
**Depends on:** 02, 08. **Success:** full betting round (fold/check/call/bet/
raise/all-in) produces stacks that the reducer confirms; illegal bets rejected
client-side and provable in the log.

## Phase 10 — Cooperative settlement (happy path)  `[P2P]`
**Goal:** at showdown, construct the payout from final stacks, collect all
co-signatures, broadcast via WDK.
**Depends on:** 08, 09. **Success:** a non-griefed hand pays the pot to the
winner via WDK on testnet, funds reconcile to the cent, escrow fully closed.

## Phase 11 — Dispute-driven settlement (grief path)  `[P2P]`
**Goal:** timeout → trigger arbitration → consume HR verdict attestation →
committee-cosigned escrow release + bond slash.
**Depends on:** 03, 04, 05, 10. **Success:** a player who quits at showdown
still loses correctly: the pot reaches the rightful winner and the quitter's
bond is slashed, with **no operator able to redirect funds**.

## Phase 12 — End-to-end testnet integration + adversarial review  `[X]`
**Goal:** prove the milestone Definition of Done under attack.
- Full real-money hand on testnet (USD₮/BTC/Lightning); griefing/abort/
  double-spend/collusion-lite tests; review pure-JS constant-time crypto
  (Chaum-Pedersen) and consider a native module; economic abort-incentive
  analysis; WDK backend-dependency failure modes.
**Depends on:** 10, 11. **Success:** the [PROJECT.md](PROJECT.md) Definition of
Done holds; a written security/economic review with no unresolved highs.

---

## Sequencing notes
- **Parallelizable now after 01:** the `[HR]` track (02→03→04→05→06) and the
  `[P2P]` wallet track (07) can run concurrently — two prongs, two owners.
- **First real integration point** is Phase 10 (needs 08+09); **trust-critical**
  integration is Phase 11 (needs the whole HR track).
- Keep **01** small and decisive — it's a spike, not a build. Everything after
  it assumes its frozen interfaces.
